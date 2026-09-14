/**
 * EDA 运行时适配层 / EDA runtime adapter
 *
 * 职责：
 * - 从画布提取板状态（器件/焊盘/过孔/铜层导线/板框）
 * - 把扇出计划写回画布（创建过孔 + 连线），支持 DRC 后校验与自动回滚
 * - 记录本插件创建的图元 ID，供一键清理
 *
 * 写回操作通过 ApplyHooks 注入（生产环境包装全局 eda，测试注入模拟实现）。
 * 坐标单位：mil。
 */
import type {
	BoardOutline,
	BoardPad,
	BoardState,
	BoardTrack,
	BoardVia,
	FanoutConfig,
	FanoutPlan,
	PlannedTrack,
	PlannedVia,
	Point,
} from './types.ts';
import { bboxOfPoints, DEFAULT_CONFIG, isCopperLayer } from './types.ts';

/** 全局 eda 对象由扩展运行时注入 */
declare const eda: any;

const BOARD_OUTLINE_LAYER = 11;

/* ------------------------- 板状态提取 ------------------------- */

export async function extractBoardState(onProgress?: (pct: number, msg: string) => void): Promise<BoardState> {
	onProgress?.(5, '读取器件与焊盘…');
	const comps = (await eda.pcb_PrimitiveComponent.getAll()) ?? [];
	if (!Array.isArray(comps))
		throw new Error('无法读取器件列表（请确认已打开 PCB 编辑器）');

	// 批量读焊盘按父器件分组（快路径）
	const padsByParent = new Map<string, any[]>();
	try {
		const pads = (await eda.pcb_PrimitivePad?.getAll?.()) ?? [];
		for (const pad of pads) {
			try {
				const pid = pad.getState_ParentComponentPrimitiveId?.();
				if (!pid)
					continue;
				const list = padsByParent.get(pid);
				if (list)
					list.push(pad);
				else
					padsByParent.set(pid, [pad]);
			}
			catch { /* 单焊盘失败跳过 */ }
		}
	}
	catch (e) {
		console.warn('[autofanout] 批量焊盘不可用，回退逐器件读取:', e);
	}

	const pads: BoardPad[] = [];
	let i = 0;
	for (const comp of comps) {
		i++;
		if (comps.length > 30 && i % 20 === 0)
			onProgress?.(10, `解析器件 ${i}/${comps.length}…`);
		try {
			const designator: string | undefined = comp.getState_Designator?.();
			if (!designator)
				continue;
			const compId: string = comp.getState_PrimitiveId();
			let padObjs: any[] | undefined = padsByParent.get(compId);
			if (!padObjs) {
				try {
					padObjs = (await comp.getAllPins?.()) ?? [];
				}
				catch {
					padObjs = [];
				}
			}
			const pins: any[] = padObjs ?? [];
			const pinCount = pins.length;
			for (const pin of pins) {
				try {
					const p = parsePad(pin, compId, designator, pinCount);
					if (p)
						pads.push(p);
				}
				catch { /* 单焊盘失败跳过 */ }
			}
		}
		catch (e) {
			console.warn('[autofanout] 读取器件失败:', e);
		}
	}

	onProgress?.(40, '读取已有过孔…');
	const vias: BoardVia[] = [];
	try {
		const viaObjs = (await eda.pcb_PrimitiveVia?.getAll?.()) ?? [];
		for (const v of viaObjs) {
			try {
				const net = String(v.getState_Net?.() ?? '');
				if (!net)
					continue; // 无网络过孔不构成电气障碍，跳过
				vias.push({ net, x: v.getState_X(), y: v.getState_Y(), diameter: v.getState_Diameter() });
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[autofanout] 读取过孔失败（忽略避让）:', e);
	}

	onProgress?.(50, '读取铜层导线…');
	const tracks: BoardTrack[] = [];
	try {
		const lineObjs = (await eda.pcb_PrimitiveLine?.getAll?.()) ?? [];
		for (const l of lineObjs) {
			try {
				const layer = l.getState_Layer?.();
				if (!isCopperLayer(layer))
					continue;
				const net = String(l.getState_Net?.() ?? '');
				if (!net)
					continue;
				tracks.push({
					net,
					layer,
					x1: l.getState_StartX(),
					y1: l.getState_StartY(),
					x2: l.getState_EndX(),
					y2: l.getState_EndY(),
					width: l.getState_LineWidth?.() ?? 10,
				});
			}
			catch { /* ignore */ }
		}
	}
	catch (e) {
		console.warn('[autofanout] 读取导线失败（忽略避让）:', e);
	}

	onProgress?.(60, '解析板框…');
	const outline = await extractOutline();

	// 提取汇总（排查"为什么没打孔"时看控制台）
	const thtCount = pads.filter(p => p.hasHole).length;
	const maskCount = pads.filter(p => (p.maskExpansionMil ?? 0) > 0).length;
	// 直插器件清单（核对：C 前缀的应是直插电解电容，若出现贴片型号说明孔数据异常）
	const thtComps = [...new Set(pads.filter(p => p.hasHole).map(p => p.designator))];
	console.log(
		`[autofanout] 提取汇总：器件 ${comps.length}，带网络焊盘 ${pads.length}`
		+ `（直插 ${thtCount}，带阻焊扩展 ${maskCount}）`
		+ `，既有过孔 ${vias.length}，铜层导线 ${tracks.length}`
		+ `，板框 ${outline.points.length ? '已识别' : '缺失(跳过板边约束)'}`,
	);
	if (thtComps.length)
		console.log(`[autofanout] 直插器件（本身是孔，跳过打孔）：${thtComps.join('、')}`);
	return { outline, pads, vias, tracks };
}

/** 单焊盘对象 -> BoardPad（形状取外接盒，读取失败回退默认尺寸） */
export function parsePad(pin: any, compId: string, designator: string, pinCount: number): BoardPad | undefined {
	const net = String(pin.getState_Net?.() ?? '');
	if (!net)
		return undefined;
	let sizeX = 40;
	let sizeY = 40;
	let shape: BoardPad['shape'] = 'RECT';
	try {
		const padShape = pin.getState_Pad?.();
		if (Array.isArray(padShape) && padShape.length >= 3) {
			shape = String(padShape[0]) as BoardPad['shape'];
			sizeX = Number(padShape[1]) || sizeX;
			sizeY = Number(padShape[2]) || sizeY;
		}
	}
	catch { /* 形状缺失用默认 */ }
	const layer = pin.getState_Layer?.();

	// 直插焊盘：钻孔为数组、孔径 > 0（['ROUND', d] / ['SLOT', d, l]），且未显式标记为非金属化。
	// 严格判定：部分封装数据的 SMT 焊盘会返回 [] / ['ROUND', 0] / null，都不算直插；
	// 金属化交叉校验排除"孔数据脏但明确非金属化"的贴片焊盘（如误判的贴片电容）。
	// holeExtentMil 记录孔径（或槽长）最大值，供 planner 做焊环几何甄别。
	let hasHole = false;
	let holeExtentMil = 0;
	try {
		const hole = pin.getState_Hole?.();
		if (Array.isArray(hole) && Number(hole[1]) > 0) {
			const metallized = pin.getState_Metallization?.();
			hasHole = metallized !== false;
			if (hasHole)
				holeExtentMil = Math.max(Number(hole[1]) || 0, Number(hole[2]) || 0);
		}
	}
	catch { /* ignore */ }

	// 阻焊层单边扩展：按焊盘所在层取 top/bottom（单位 mil）。
	// null/undefined = 跟随设计规则，按 0 处理（贴铜皮边缘就近）；
	// 异常大值钳到 50mil（约 1.27mm）防脏数据把就近距离推远。
	let maskExpansionMil = 0;
	try {
		const exp = pin.getState_SolderMaskAndPasteMaskExpansion?.();
		if (exp && typeof exp === 'object') {
			const v = layer === 2 ? exp.bottomSolderMask : exp.topSolderMask;
			const n = Number(v);
			if (Number.isFinite(n) && n >= 0)
				maskExpansionMil = Math.min(n, 50);
		}
	}
	catch { /* ignore */ }

	return {
		compId,
		designator,
		padNumber: String(pin.getState_PadNumber?.() ?? ''),
		net,
		netClass: 'signal', // 由 planner 按 cfg 重新分类
		x: pin.getState_X(),
		y: pin.getState_Y(),
		sizeX,
		sizeY,
		shape,
		layer: layer === 2 ? 2 : 1, // 1=顶 2=底，MULTI(12) 按顶处理
		rawLayer: Number.isFinite(layer) ? layer : undefined, // 保留原值：真直插焊盘必为 12（多层）
		pinCount,
		hasHole,
		holeExtentMil,
		maskExpansionMil,
	};
}

/** 板框：层 11 图元 -> 凸包多边形 */
async function extractOutline(): Promise<BoardOutline> {
	const points: Point[] = [];
	const push = (x: unknown, y: unknown) => {
		const nx = Number(x);
		const ny = Number(y);
		if (Number.isFinite(nx) && Number.isFinite(ny))
			points.push({ x: nx, y: ny });
	};
	try {
		for (const pl of (await eda.pcb_PrimitivePolyline?.getAll?.()) ?? []) {
			if (pl.getState_Layer?.() !== BOARD_OUTLINE_LAYER)
				continue;
			try {
				await pl.reset?.();
			}
			catch { /* ignore */ }
			// A) 实例离散化
			try {
				const poly = pl.getState_Polygon?.();
				if (poly?.discretize) {
					const pts = await poly.discretize({ tolerance: 100 });
					if (Array.isArray(pts) && pts.length) {
						for (const p of pts)
							push(p.x, p.y);
						continue;
					}
				}
			}
			catch { /* 降级 */ }
			// B) 静态离散化
			try {
				const poly = pl.getState_Polygon?.();
				const src = typeof poly?.getSource === 'function' ? poly.getSource() : (Array.isArray(poly) ? poly : undefined);
				if (Array.isArray(src) && src.length && eda.pcb_MathPolygon?.discretize) {
					const pts = await eda.pcb_MathPolygon.discretize(src, { tolerance: 100 });
					if (Array.isArray(pts) && pts.length) {
						for (const p of pts)
							push(p.x, p.y);
						continue;
					}
				}
				// C) 源数组手动解析：数字两两配对为近似点（凸包可接受）
				if (Array.isArray(src) && src.length) {
					const nums = src.filter((v: unknown) => typeof v === 'number' && Number.isFinite(v)) as number[];
					for (let k = 0; k + 1 < nums.length; k += 2)
						push(nums[k], nums[k + 1]);
				}
			}
			catch { /* ignore */ }
		}
	}
	catch { /* ignore */ }
	try {
		for (const l of (await eda.pcb_PrimitiveLine?.getAll?.()) ?? []) {
			if (l.getState_Layer?.() !== BOARD_OUTLINE_LAYER)
				continue;
			push(l.getState_StartX(), l.getState_StartY());
			push(l.getState_EndX(), l.getState_EndY());
		}
	}
	catch { /* ignore */ }
	try {
		for (const a of (await eda.pcb_PrimitiveArc?.getAll?.()) ?? []) {
			if (a.getState_Layer?.() !== BOARD_OUTLINE_LAYER)
				continue;
			push(a.getState_StartX(), a.getState_StartY());
			push(a.getState_EndX(), a.getState_EndY());
		}
	}
	catch { /* ignore */ }

	if (points.length < 3) {
		// 板框缺失时退化为无穷大 bbox（不打板边约束），多边形为空
		console.warn('[autofanout] 未找到板框，跳过板边约束');
		return { points: [], bbox: { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 } };
	}
	const poly = convexHull(points);
	return { points: poly, bbox: bboxOfPoints(poly) };
}

/** Andrew 单调链凸包 */
function convexHull(pts: Point[]): Point[] {
	const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower: Point[] = [];
	for (const pt of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0)
			lower.pop();
		lower.push(pt);
	}
	const upper: Point[] = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const pt = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0)
			upper.pop();
		upper.push(pt);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
}

/* ------------------------- 计划写回（可注入 hooks） ------------------------- */

export interface ApplyHooks {
	createVia: (v: PlannedVia) => Promise<string | undefined>;
	createLine: (t: PlannedTrack) => Promise<string | undefined>;
	deletePrimitives: (ids: string[]) => Promise<boolean>;
	/** 违规数组（verbose 模式）；接口不可用返回 undefined */
	drcViolations: () => Promise<Array<any> | undefined>;
}

/** 生产 hooks：包装全局 eda */
export function createEdaHooks(): ApplyHooks {
	return {
		async createVia(v) {
			const via = await eda.pcb_PrimitiveVia.create(v.net, v.x, v.y, v.holeDiameter, v.diameter);
			return via?.getState_PrimitiveId?.();
		},
		async createLine(t) {
			const line = await eda.pcb_PrimitiveLine.create(t.net, t.layer, t.x1, t.y1, t.x2, t.y2, t.width);
			return line?.getState_PrimitiveId?.();
		},
		async deletePrimitives(ids) {
			if (!ids.length)
				return true;
			const viaIds = ids.filter(id => id.startsWith('af-via:')).map(s => s.slice(7));
			const lineIds = ids.filter(id => id.startsWith('af-line:')).map(s => s.slice(8));
			let ok = true;
			if (viaIds.length)
				ok = (await eda.pcb_PrimitiveVia.delete(viaIds)) && ok;
			if (lineIds.length)
				ok = (await eda.pcb_PrimitiveLine.delete(lineIds)) && ok;
			return ok;
		},
		async drcViolations() {
			try {
				return (await eda.pcb_Drc.check(true, false, true)) as Array<any>;
			}
			catch (e) {
				console.warn('[autofanout] DRC 接口不可用:', e);
				return undefined;
			}
		},
	};
}

export interface ApplyResult {
	applied: number;
	failed: number;
	drcChecked: boolean;
	/** DRC 新增违规数（回滚前） */
	newViolations: number;
	/** 因 DRC 新增违规整体回滚 */
	rolledBack: boolean;
	createdViaIds: string[];
	createdLineIds: string[];
}

/**
 * 应用计划到画布。
 * - 每项先创建过孔再创建连线；连线失败则删除该项过孔（单项回滚）
 * - 启用 DRC 后校验时（非宽松模式）：记录创建前违规数，创建后复查，新增违规 -> 全量回滚
 */
export async function applyPlan(
	plan: FanoutPlan,
	cfg: FanoutConfig,
	hooks: ApplyHooks,
	onProgress?: (done: number, total: number, msg: string) => void,
): Promise<ApplyResult> {
	// 宽松模式自动跳过 DRC 后校验（预检查已放宽，DRC 必然新增违规，回滚无意义）
	const drcEnabled = cfg.useDrcCheck && !cfg.relaxedMode;
	const beforeViolations = drcEnabled ? await hooks.drcViolations() : undefined;
	const drcAvailable = drcEnabled && Array.isArray(beforeViolations);

	const viaIds: string[] = [];
	const lineIds: string[] = [];
	let failed = 0;

	for (let i = 0; i < plan.items.length; i++) {
		const item = plan.items[i];
		onProgress?.(i, plan.items.length, `打孔 ${i + 1}/${plan.items.length}：${item.pad.designator}-${item.pad.padNumber} (${item.via.net})`);
		try {
			const viaId = await hooks.createVia(item.via);
			if (!viaId)
				throw new Error('创建过孔失败');
			// 盘中孔项无连线（过孔与焊盘同中心，直接电气连通）
			const lineId = item.track ? await hooks.createLine(item.track) : undefined;
			if (item.track && !lineId) {
				await hooks.deletePrimitives([`af-via:${viaId}`]);
				throw new Error('创建连线失败');
			}
			viaIds.push(viaId);
			if (lineId)
				lineIds.push(lineId);
		}
		catch (e) {
			failed++;
			console.warn(`[autofanout] ${item.pad.designator}-${item.pad.padNumber} 失败:`, e);
		}
	}

	let newViolations = 0;
	let rolledBack = false;
	if (drcAvailable) {
		onProgress?.(plan.items.length, plan.items.length, 'DRC 校验中…');
		const after = await hooks.drcViolations();
		if (Array.isArray(after)) {
			newViolations = Math.max(0, after.length - (beforeViolations as Array<any>).length);
			if (newViolations > 0 && (viaIds.length || lineIds.length)) {
				await hooks.deletePrimitives([...viaIds.map(id => `af-via:${id}`), ...lineIds.map(id => `af-line:${id}`)]);
				rolledBack = true;
			}
		}
	}

	const result: ApplyResult = {
		applied: rolledBack ? 0 : viaIds.length,
		failed,
		drcChecked: drcAvailable,
		newViolations,
		rolledBack,
		createdViaIds: rolledBack ? [] : viaIds,
		createdLineIds: rolledBack ? [] : lineIds,
	};
	if (!rolledBack)
		await persistCreatedIds(viaIds, lineIds);
	return result;
}

/* ------------------------- 创建记录（供清理） ------------------------- */

const CREATED_KEY = 'fanoutCreatedIds';

function loadCreated(): { vias: string[]; lines: string[] } {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CREATED_KEY);
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object')
			return { vias: Array.isArray(parsed.vias) ? parsed.vias : [], lines: Array.isArray(parsed.lines) ? parsed.lines : [] };
	}
	catch { /* ignore */ }
	return { vias: [], lines: [] };
}

async function persistCreatedIds(viaIds: string[], lineIds: string[]): Promise<void> {
	try {
		const cur = loadCreated();
		await eda.sys_Storage.setExtensionUserConfig(
			CREATED_KEY,
			JSON.stringify({ vias: [...cur.vias, ...viaIds], lines: [...cur.lines, ...lineIds] }),
		);
	}
	catch (e) {
		console.warn('[autofanout] 记录创建 ID 失败（不影响打孔结果）:', e);
	}
}

/** 删除本插件历史创建的全部过孔/连线 */
export async function cleanupCreated(hooks: ApplyHooks = createEdaHooks()): Promise<{ vias: number; lines: number }> {
	const cur = loadCreated();
	if (!cur.vias.length && !cur.lines.length)
		return { vias: 0, lines: 0 };
	await hooks.deletePrimitives([
		...cur.vias.map(id => `af-via:${id}`),
		...cur.lines.map(id => `af-line:${id}`),
	]);
	await eda.sys_Storage.setExtensionUserConfig(CREATED_KEY, JSON.stringify({ vias: [], lines: [] }));
	return { vias: cur.vias.length, lines: cur.lines.length };
}

/* ------------------------- 配置存取 ------------------------- */

const CONFIG_KEY = 'fanoutConfig';

export function loadConfig(): FanoutConfig {
	let saved = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	if (typeof saved === 'string' && saved.trim().startsWith('{')) {
		try {
			saved = JSON.parse(saved);
		}
		catch { /* 保持原值 */ }
	}
	return { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
}

export async function saveConfig(cfg: FanoutConfig): Promise<boolean> {
	await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, JSON.stringify(cfg));
	const back = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
	return typeof back === 'string' && back.includes('"viaDiameterMm"');
}
