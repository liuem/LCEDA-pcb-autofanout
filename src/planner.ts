import type {
	BoardPad,
	BoardState,
	BoardTrack,
	BoardVia,
	FanoutConfig,
	FanoutPlan,
	FanoutRules,
	PlanItem,
	PlannedTrack,
	PlannedVia,
	PlanSkip,
} from './types.ts';
import {
	capsuleCircleClearance,
	capsulePadClearance,
	circleClearance,
	distSegSeg,
	insideBoard,
	padExtent,
	pointPadClearance,
} from './geometry.ts';
/**
 * 扇出规划器 / Fanout planner（纯函数，可离线测试）
 *
 * 对每个电源/地焊盘：优先沿直线方向（0/90/180/270°），45° 斜向仅作后备；
 * 在理想距离上生成候选过孔位置——过孔边缘贴焊盘边界（阻焊开窗边缘，
 * 读不到阻焊扩展时用焊盘铜皮边缘）+ 可选额外余量 stub，
 * 即在间距规则允许范围内尽量就近；
 * 每个候选位置做局部间距预检查（板边/异网络焊盘/过孔/走线），
 * 阻塞时沿方向逐档外扩（每档一个过孔外径）。
 * 直插（金属化孔）焊盘本身就是通孔，跳过不打。
 * 焊盘->过孔连线宽度恒不超过焊盘尺寸。
 */
import { classifyNet, parseNetPatterns } from './net-classify.ts';
import { configToRules, THT_MIN_RING_MIL } from './types.ts';

/** 8 个候选方向（度） */
const ALL_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * 方向优先级：直线方向（0/90/180/270°）优先于 45° 斜向；
 * 直线中焊盘长轴方向最先（逃逸方向），短轴次之，斜向最后作后备
 */
function orderedDirections(pad: BoardPad): number[] {
	if (pad.sizeX > pad.sizeY * 1.25)
		return [0, 180, 90, 270, 45, 135, 225, 315];
	if (pad.sizeY > pad.sizeX * 1.25)
		return [90, 270, 0, 180, 45, 135, 225, 315];
	return [0, 90, 180, 270, 45, 135, 225, 315];
}

/**
 * 直插真伪甄别（防封装库脏孔数据把贴片误判为直插）。
 * 真直插焊盘须同时满足三条物理判据，任一不满足即按贴片处理（照常打孔）：
 * a) 多层焊盘：孔贯通全板，焊盘层必须是 MULTI(12)；
 *    单层铜皮（1/2）上的孔数据必是脏数据（SDK 定义焊盘层仅 1/2/12）
 * b) 焊环完整：孔径 + 0.3mm <= 焊盘长边，孔塞不进焊盘的不可能是真直插
 * c) 器件共识：真直插件的全部焊盘都带孔；件内只有部分焊盘带孔 -> 脏数据
 */
function isRealThroughHolePad(pad: BoardPad, compHoles: { total: number; holed: number } | undefined): boolean {
	if (!pad.hasHole)
		return false;
	if (pad.rawLayer === 1 || pad.rawLayer === 2)
		return false;
	const hole = pad.holeExtentMil ?? 0;
	if (hole > 0 && hole + THT_MIN_RING_MIL > Math.max(pad.sizeX, pad.sizeY))
		return false;
	if (compHoles && compHoles.total >= 2 && compHoles.holed < compHoles.total)
		return false;
	return true;
}

/**
 * 位置搜索：外扩步数为外层、方向为内层——
 * 先在全部 8 个方向上尝试理想距离（就近优先），
 * 全部阻塞后再逐档外扩（每档一个过孔外径）。
 * 理想距离 = 焊盘边界（阻焊开窗或铜皮边缘，沿该方向投影）+ 过孔半径 + stub。
 * viaRadius/hole 为本次尝试的过孔尺寸（主过孔或回退小过孔）。
 */
function searchPosition(
	pad: BoardPad,
	rules: FanoutRules,
	state: BoardState,
	vias: BoardVia[],
	tracks: BoardTrack[],
	viaRadius: number,
): FoundPos | undefined {
	const width = traceWidthFor(pad, rules, viaRadius);
	for (let step = 0; step <= rules.maxSearchSteps; step++) {
		for (const dirDeg of orderedDirections(pad)) {
			const rad = (dirDeg * Math.PI) / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);
			const dist = padExtent(pad, rad, rules.useMask) + rules.stub + viaRadius + step * viaRadius * 2;
			const vx = pad.x + dist * cos;
			const vy = pad.y + dist * sin;
			if (!viaPositionOk(vx, vy, pad, rules, state, vias, tracks, viaRadius))
				continue;
			if (!tracePathOk(pad, vx, vy, width, rules, state, vias, tracks))
				continue;
			return { x: vx, y: vy, dirDeg, dist, step };
		}
	}
	return undefined;
}

/** 焊盘-过孔连线宽度：恒不超过焊盘短边（用户要求），自动模式取 min(焊盘短边, 过孔外径) */
function traceWidthFor(pad: BoardPad, rules: FanoutRules, viaRadius: number): number {
	const padMin = Math.min(pad.sizeX, pad.sizeY);
	if (rules.traceWidth > 0)
		return Math.min(rules.traceWidth, padMin);
	return Math.min(padMin, viaRadius * 2);
}

/**
 * 规划扇出。
 * @param state 板状态（焊盘 netClass 字段会被忽略，以 cfg 重新分类）
 */
export function planFanout(state: BoardState, cfg: FanoutConfig): FanoutPlan {
	const rules = configToRules(cfg);
	const patterns = parseNetPatterns(cfg.netPatterns);
	const classifyOpts = {
		useBuiltin: cfg.useBuiltinPatterns,
		patterns,
		includePower: cfg.includePower,
		includeGround: cfg.includeGround,
	};

	const items: PlanItem[] = [];
	const skips: PlanSkip[] = [];
	const ignoredMap = new Map<string, number>();

	// 工作副本：新放入的过孔/连线立即成为后续焊盘的障碍
	const vias: BoardVia[] = [...state.vias];
	const tracks: BoardTrack[] = [...state.tracks];

	// 器件级孔共识统计（含非电源焊盘）：真直插件的所有焊盘都带孔
	const compHoles = new Map<string, { total: number; holed: number }>();
	for (const p of state.pads) {
		const s = compHoles.get(p.compId) ?? { total: 0, holed: 0 };
		s.total++;
		if (p.hasHole)
			s.holed++;
		compHoles.set(p.compId, s);
	}
	const thtSuspects: string[] = [];

	for (const pad of state.pads) {
		const netClass = classifyNet(pad.net, classifyOpts);
		if (netClass === 'signal' || !pad.net)
			continue;

		// 直插（金属化孔）焊盘本身就是通孔，已贯通所有层，无需再打过孔。
		// 三重甄别（多层/焊环/器件共识）任一不通过 = 疑似脏孔 -> 按贴片照常打孔
		if (rules.skipTht && isRealThroughHolePad(pad, compHoles.get(pad.compId))) {
			skips.push({ designator: pad.designator, padNumber: pad.padNumber, net: pad.net, reason: 'tht-pad', detail: '真直插孔（多层+全孔+焊环校验通过）' });
			continue;
		}
		if (pad.hasHole && rules.skipTht)
			thtSuspects.push(`${pad.designator}-${pad.padNumber}`);

		if (pad.pinCount > rules.maxPins) {
			ignoredMap.set(pad.designator, pad.pinCount);
			skips.push({ designator: pad.designator, padNumber: pad.padNumber, net: pad.net, reason: 'too-many-pins', detail: `${pad.pinCount} pins > ${rules.maxPins}` });
			continue;
		}

		// 注意：不因焊盘压板边而整体跳过（边沿连接器焊盘常超出板框），
		// 过孔位置本身有板边 margin 校验，向板内方向仍可打孔。

		// 同网络已有过孔（含本规划已放入）在焊盘扇出邻域内 -> 不重复打。
		// 邻域 = 最远理想距离 + mergeFactor 个过孔外径
		const maxIdeal = Math.max(...ALL_DIRS.map(d => padExtent(pad, (d * Math.PI) / 180, rules.useMask))) + rules.stub + rules.viaRadius;
		const mergeRadius = maxIdeal + rules.viaRadius * 2 * rules.mergeFactor;
		const nearest = Math.min(...vias.filter(v => v.net === pad.net).map(v => Math.hypot(v.x - pad.x, v.y - pad.y)));
		if (nearest <= mergeRadius) {
			skips.push({ designator: pad.designator, padNumber: pad.padNumber, net: pad.net, reason: 'merged-with-existing-via', detail: `距最近同网络过孔 ${(nearest * 0.0254).toFixed(2)}mm（合并半径 ${(mergeRadius * 0.0254).toFixed(2)}mm）` });
			continue;
		}

		// 盘中孔：过孔直接打在焊盘中心（无需连线）。
		// 要求过孔整圆落在焊盘内（外径 <= 焊盘短边）且中心位置通过避让校验；
		// 主过孔放不下时试回退小过孔，仍不行则自动回退就近搜索
		let found: FoundPos | undefined;
		let usedFallback = false;
		let viaHole = rules.viaHole;
		let viaDiameter = rules.viaRadius * 2;
		let inPad = false;
		if (rules.viaInPad) {
			const centerOk = (radius: number): boolean =>
				radius > 0
				&& radius * 2 <= Math.min(pad.sizeX, pad.sizeY)
				&& viaPositionOk(pad.x, pad.y, pad, rules, state, vias, tracks, radius);
			if (centerOk(rules.viaRadius)) {
				found = { x: pad.x, y: pad.y, dirDeg: 0, dist: 0, step: 0 };
				inPad = true;
			}
			else if (rules.fallbackViaRadius > 0 && centerOk(rules.fallbackViaRadius)) {
				found = { x: pad.x, y: pad.y, dirDeg: 0, dist: 0, step: 0 };
				inPad = true;
				usedFallback = true;
				viaHole = rules.fallbackViaHole;
				viaDiameter = rules.fallbackViaRadius * 2;
			}
		}
		// 就近搜索：8 方向全阻塞且配置了更小的回退过孔时，换小一号重试
		// （0402 等小封装密集区常塞不下主过孔，小过孔 + 同样间距往往能进）
		if (!found)
			found = searchPosition(pad, rules, state, vias, tracks, rules.viaRadius);
		if (!found && rules.fallbackViaRadius > 0) {
			const fb = searchPosition(pad, rules, state, vias, tracks, rules.fallbackViaRadius);
			if (fb) {
				found = fb;
				usedFallback = true;
				viaHole = rules.fallbackViaHole;
				viaDiameter = rules.fallbackViaRadius * 2;
			}
		}
		if (!found) {
			skips.push({ designator: pad.designator, padNumber: pad.padNumber, net: pad.net, reason: 'blocked', detail: '8 方向全部阻塞' });
			continue;
		}

		const viaRadiusUsed = viaDiameter / 2;
		const via: PlannedVia = {
			net: pad.net,
			x: Math.round(found.x * 100) / 100,
			y: Math.round(found.y * 100) / 100,
			holeDiameter: viaHole,
			diameter: viaDiameter,
		};
		const width = traceWidthFor(pad, rules, viaRadiusUsed);
		// 盘中孔与焊盘同中心，无需连线
		const track: PlannedTrack | undefined = inPad
			? undefined
			: {
					net: pad.net,
					layer: pad.layer,
					x1: pad.x,
					y1: pad.y,
					x2: via.x,
					y2: via.y,
					width,
				};
		items.push({
			pad: {
				designator: pad.designator,
				padNumber: pad.padNumber,
				net: pad.net,
				netClass,
				x: pad.x,
				y: pad.y,
				layer: pad.layer,
				sizeX: pad.sizeX,
				sizeY: pad.sizeY,
			},
			via,
			track,
			directionDeg: found.dirDeg,
			distanceMil: Math.round(found.dist * 100) / 100,
			searchStep: found.step,
			usedFallback,
			viaInPad: inPad ? true : undefined,
		});
		vias.push({ net: via.net, x: via.x, y: via.y, diameter: via.diameter });
		if (track)
			tracks.push({ net: track.net, layer: track.layer, x1: track.x1, y1: track.y1, x2: track.x2, y2: track.y2, width: track.width });
	}

	const eligible = items.length
		+ skips.filter(s => s.reason !== 'too-many-pins').length;
	return {
		items,
		skips,
		ignoredComps: [...ignoredMap.entries()].map(([designator, pinCount]) => ({ designator, pinCount })),
		thtSuspects,
		stats: {
			totalPads: eligible + skips.filter(s => s.reason === 'too-many-pins').length,
			eligiblePads: eligible,
			planned: items.length,
			tht: skips.filter(s => s.reason === 'tht-pad').length,
			thtSuspect: thtSuspects.length,
			merged: skips.filter(s => s.reason === 'merged-with-existing-via').length,
			blocked: skips.filter(s => s.reason === 'blocked').length,
			viaInPad: items.filter(it => it.viaInPad).length,
		},
	};
}

/* ------------------------- 位置搜索与校验 ------------------------- */

interface FoundPos {
	x: number;
	y: number;
	dirDeg: number;
	dist: number;
	step: number;
}

/** 过孔位置校验：板内 + 与所有铜障碍保持 clearance（源焊盘除外，伸出距离已保证） */
function viaPositionOk(
	vx: number,
	vy: number,
	srcPad: BoardPad,
	rules: FanoutRules,
	state: BoardState,
	vias: BoardVia[],
	tracks: BoardTrack[],
	viaRadius: number,
): boolean {
	if (!insideBoard(vx, vy, state.outline, rules.clearance + viaRadius))
		return false;

	for (const p of state.pads) {
		if (p === srcPad)
			continue;
		if (pointPadClearance(vx, vy, p) - viaRadius < rules.clearance)
			return false;
	}
	for (const v of vias) {
		if (circleClearance(vx, vy, viaRadius, v.x, v.y, v.diameter / 2) < rules.clearance)
			return false;
	}
	for (const t of tracks) {
		if (capsuleCircleClearance(t.x1, t.y1, t.x2, t.y2, t.width, vx, vy, viaRadius) < rules.clearance)
			return false;
	}
	return true;
}

/**
 * 焊盘->过孔连线通道校验：胶囊体（线宽 + clearance）不与异网络铜冲突。
 * 同网络铜允许接触（电气同网）；跨层障碍不检查（连线只在焊盘所在层），
 * 过孔本身已由 viaPositionOk 对全部铜层校验。
 * 宽松模式直接放行（板子已有 DRC 违规时连线可能压线，用户自负）。
 */
function tracePathOk(
	srcPad: BoardPad,
	vx: number,
	vy: number,
	width: number,
	rules: FanoutRules,
	state: BoardState,
	vias: BoardVia[],
	tracks: BoardTrack[],
): boolean {
	if (rules.relaxed)
		return true;
	const margin = rules.clearance;
	for (const p of state.pads) {
		if (p === srcPad || p.net === srcPad.net || p.layer !== srcPad.layer)
			continue;
		if (capsulePadClearance(srcPad.x, srcPad.y, vx, vy, width + margin * 2, p) < 0)
			return false;
	}
	for (const v of vias) {
		if (v.net === srcPad.net)
			continue;
		if (capsuleCircleClearance(srcPad.x, srcPad.y, vx, vy, width + margin * 2, v.x, v.y, v.diameter / 2) < 0)
			return false;
	}
	for (const t of tracks) {
		if (t.net === srcPad.net || t.layer !== srcPad.layer)
			continue;
		if (distSegSeg(srcPad.x, srcPad.y, vx, vy, t.x1, t.y1, t.x2, t.y2) - (width + t.width) / 2 - margin < 0)
			return false;
	}
	return true;
}

const SKIP_REASON_LABEL: Record<string, string> = {
	'too-many-pins': '引脚超限',
	'tht-pad': '直插孔',
	'merged-with-existing-via': '已有就近过孔',
	'blocked': '无有效位置',
};

/** 计划摘要（预览/报告用） */
export function planSummary(plan: FanoutPlan, relaxed = false): string {
	const lines: string[] = [];
	lines.push(`计划打孔 ${plan.items.length} 个（候选电源/地焊盘 ${plan.stats.eligiblePads} 个）`);
	if (relaxed)
		lines.push('⚠ 宽松模式：忽略间距预检查，可能引入新 DRC 违规');
	if (plan.ignoredComps.length)
		lines.push(`忽略高引脚器件：${plan.ignoredComps.map(c => `${c.designator}(${c.pinCount}p)`).join('、')}（设置面板调大阈值可包含）`);
	if (plan.stats.tht)
		lines.push(`直插孔焊盘跳过（本身是孔）：${plan.stats.tht} 个`);
	if (plan.stats.thtSuspect)
		lines.push(`疑似直插误判已按贴片处理：${plan.stats.thtSuspect} 个焊盘（${plan.thtSuspects.slice(0, 8).join('、')}${plan.thtSuspects.length > 8 ? '…' : ''}）`);
	if (plan.stats.merged)
		lines.push(`已有就近过孔跳过：${plan.stats.merged} 个焊盘`);
	if (plan.stats.blocked)
		lines.push(`无有效位置跳过：${plan.stats.blocked} 个焊盘（可试增大外扩步数/减小过孔）`);
	// 按器件汇总：一个封装完全没打上孔时，直接给出原因分布
	const plannedComps = new Set(plan.items.map(it => it.pad.designator));
	const byComp = new Map<string, Map<string, number>>();
	for (const s of plan.skips) {
		if (plannedComps.has(s.designator))
			continue; // 该器件已有部分打孔，只看"全军覆没"的
		let m = byComp.get(s.designator);
		if (!m) {
			m = new Map<string, number>();
			byComp.set(s.designator, m);
		}
		m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
	}
	if (byComp.size) {
		const rows = [...byComp.entries()].slice(0, 12).map(([des, m]) => `${des}：${[...m.entries()].map(([r, n]) => `${SKIP_REASON_LABEL[r] ?? r}×${n}`).join('，')}`);
		lines.push(`未打孔器件原因：${rows.join('；')}${byComp.size > 12 ? '…' : ''}`);
	}
	if (plan.items.some(it => it.usedFallback))
		lines.push(`其中 ${plan.items.filter(it => it.usedFallback).length} 个用了回退小过孔`);
	if (plan.stats.viaInPad)
		lines.push(`其中 ${plan.stats.viaInPad} 个为盘中孔（焊盘中心直放）`);
	if (plan.items.length) {
		const byNet = new Map<string, number>();
		for (const it of plan.items)
			byNet.set(it.via.net, (byNet.get(it.via.net) ?? 0) + 1);
		lines.push(`按网络：${[...byNet.entries()].map(([n, c]) => `${n}×${c}`).join('，')}`);
	}
	return lines.join('\n');
}
