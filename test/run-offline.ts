/**
 * 离线测试 / Offline tests（不依赖 EDA 运行时，node 直接运行）
 *
 * 覆盖：网络分类、BGA/引脚数过滤、位置搜索与避让（板边/异网络障碍/走线分层）、
 * 线宽不超过焊盘尺寸、就近距离（阻焊边界）、合并去重、直插/压板边焊盘、
 * 直插脏孔三重甄别（多层/焊环/器件共识）、盘中孔中心直放与回退、
 * applyPlan 写回与 DRC 回滚、parsePad 焊盘识别。
 *
 * 用法：node test/run-offline.ts
 */
import type { ApplyHooks } from '../src/eda-adapter.ts';
import type { FanoutConfig, FanoutPlan } from '../src/types.ts';
import process from 'node:process';
import { applyPlan, parsePad } from '../src/eda-adapter.ts';
import {
	capsuleCircleClearance,
	circleClearance,
	distPointSeg,
	insideBoard,
	padExtent,
	pointPadClearance,
} from '../src/geometry.ts';
import { classifyBuiltIn, classifyNet, parseNetPatterns } from '../src/net-classify.ts';
import { planFanout, planSummary } from '../src/planner.ts';
import { DEFAULT_CONFIG, MM_TO_MIL } from '../src/types.ts';
import { buildFixture } from './fixture.ts';

const mm = (v: number) => v * MM_TO_MIL;

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = ''): void {
	checks++;
	if (!cond) {
		failures++;
		console.error(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
	}
}

function eq<T>(actual: T, expected: T, label: string): void {
	ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/* ---------------- 1. 网络分类 ---------------- */

function testNetClassify(): void {
	console.log('\n[1] 网络分类');
	for (const n of ['GND', 'AGND', 'PGND', 'DGND', 'GND1', 'GND_PLL', 'GROUND', 'EARTH', 'Earth'])
		eq(classifyBuiltIn(n), 'ground', `${n} -> ground`);
	for (const n of ['VCC', 'VDD', 'VEE', 'VBUS', 'VBAT', 'VSYS', 'VIN', 'VDDA', 'VCC3V3'])
		eq(classifyBuiltIn(n), 'power', `${n} -> power`);
	for (const n of ['5V', '3V3', '1V8', '2V5', '12V', '3.3V', '5V0', '+5V', '+3V3', '-5V', '+BATT'])
		eq(classifyBuiltIn(n), 'power', `${n} -> power`);
	for (const n of ['USB_DP', 'LED', 'NRST', 'MOSI', 'SWCLK', 'P23', 'VSS'])
		eq(classifyBuiltIn(n), 'signal', `${n} -> signal`);

	// 自定义模式
	eq(classifyNet('MOTOR_PWR', { patterns: parseNetPatterns('MOTOR_PWR') }), 'power', '自定义 MOTOR_PWR -> power');
	eq(classifyNet('AGND2', { patterns: parseNetPatterns('GND') }), 'ground', '自定义 GND 包含匹配 AGND2 -> ground');
	eq(classifyNet('MOTOR_PWR', {}), 'signal', '无自定义时 MOTOR_PWR -> signal');
	eq(classifyNet('3V3', { includePower: false }), 'signal', '关闭电源后 3V3 -> signal');
	eq(classifyNet('VCC', { useBuiltin: false, patterns: [] }), 'signal', '关闭内置后 VCC -> signal');
}

/* ---------------- 2. 规划主流程（默认配置） ---------------- */

function planOf(cfg?: Partial<FanoutConfig>): FanoutPlan {
	return planFanout(buildFixture(), { ...DEFAULT_CONFIG, ...cfg });
}

function itemsOf(plan: FanoutPlan, designator: string) {
	return plan.items.filter(it => it.pad.designator === designator);
}

function testPlan(): void {
	console.log('\n[2] 规划主流程（默认配置：过孔 0.3/0.6mm，stub=0 贴阻焊边界，阈值 32 脚）');
	const plan = planOf();

	// BGA/高引脚器件整体忽略
	ok(plan.ignoredComps.some(c => c.designator === 'B1' && c.pinCount === 256), 'B1(256 脚) 出现在忽略器件列表');
	ok(plan.ignoredComps.some(c => c.designator === 'U1' && c.pinCount === 48), 'U1(48 脚) 出现在忽略器件列表');
	eq(itemsOf(plan, 'B1').length, 0, 'BGA B1 无任何过孔');
	eq(itemsOf(plan, 'U1').length, 0, 'LQFP48 U1 无任何过孔（默认阈值 32）');

	// 阈值放宽后 U1 不再因引脚数被忽略
	const planWide = planOf({ maxPins: 100 });
	ok(!planWide.ignoredComps.some(c => c.designator === 'U1'), 'maxPins=100 时 U1 不再整体忽略');
	ok(!planWide.skips.some(s => s.designator === 'U1' && s.reason === 'too-many-pins'), 'maxPins=100 时 U1 无 too-many-pins 跳过');

	// 合并去重：C1-GND 焊盘（明细含最近同网络过孔距离）
	const c1GndSkip = plan.skips.find(s => s.designator === 'C1' && s.padNumber === '1');
	ok(!!c1GndSkip && c1GndSkip.reason === 'merged-with-existing-via', 'C1-GND 因就近既有 GND 过孔跳过', c1GndSkip?.reason);
	ok((c1GndSkip?.detail ?? '').includes('mm'), '合并跳过明细含距离（mm）', c1GndSkip?.detail);
	eq(itemsOf(plan, 'C1').length, 1, 'C1 仅 1 个过孔（GND 已合并）');

	// 直插件跳过：J2 两个带孔焊盘本身就是通孔，不打孔
	const j2Skips = plan.skips.filter(s => s.designator === 'J2');
	eq(j2Skips.length, 2, 'J2 两个直插焊盘全部跳过');
	ok(j2Skips.every(s => s.reason === 'tht-pad'), 'J2 跳过原因是直插孔', j2Skips.map(s => s.reason).join(','));
	eq(itemsOf(plan, 'J2').length, 0, 'J2 无任何过孔');
	eq(plan.stats.tht, 2, 'stats.tht = 2');

	// 关闭直插跳过判定后 J2 也参与打孔（孔数据误判贴片时的逃生开关）
	const planNoTht = planOf({ skipThiPads: false });
	eq(itemsOf(planNoTht, 'J2').length, 2, 'skipThiPads=false 时 J2 直插焊盘也打孔');
	eq(planNoTht.stats.tht, 0, 'skipThiPads=false 时无 tht 跳过');

	// U2 四焊盘全部打孔；J1 两个大焊盘打孔
	eq(itemsOf(plan, 'U2').length, 4, 'U2 SOT-223 四焊盘全打孔');
	eq(itemsOf(plan, 'J1').length, 2, 'J1 两焊盘全打孔');
	ok(itemsOf(plan, 'J1').some(it => it.via.net === '+5V') && itemsOf(plan, 'J1').some(it => it.via.net === 'GND'), 'J1 网络 +5V/GND 正确');

	// 底层器件：连线层 = 底层
	const r9 = itemsOf(plan, 'R9');
	eq(r9.length, 2, 'R9 底层 0603 两焊盘全打孔');
	ok(r9.every(it => it.track.layer === 2), 'R9 连线落在底层', r9.map(it => it.track.layer).join(','));

	// 0402 阵列（上下 1mm 逃线）：主过孔塞不下 -> 回退小过孔；端头无邻居用主过孔
	const bank = plan.items.filter(it => /^C1[1-6]$/.test(it.pad.designator));
	eq(bank.length, 12, '0402 阵列 12 焊盘全部打上');
	const fbItems = bank.filter(it => it.usedFallback);
	eq(fbItems.length, 10, '中间 10 个用回退小过孔');
	ok(fbItems.every(it => Math.abs(it.via.diameter - mm(0.4)) < 0.01 && Math.abs(it.via.holeDiameter - mm(0.2)) < 0.01), '回退尺寸 = 0.2/0.4mm');
	ok(bank.filter(it => !it.usedFallback).every(it => Math.abs(it.via.diameter - mm(0.6)) < 0.01), '端头 2 个仍用主过孔 0.6mm');
	ok(plan.items.filter(it => !/^C1[1-6]$/.test(it.pad.designator)).every(it => !it.usedFallback), '其他器件不受回退影响');

	// 关闭回退后 0402 中间焊盘 blocked
	const planNoFb = planOf({ fallbackViaDiameterMm: 0, fallbackViaHoleMm: 0 });
	const bankNoFb = planNoFb.items.filter(it => /^C1[1-6]$/.test(it.pad.designator));
	eq(bankNoFb.length, 2, '关闭回退后仅端头 2 个可打');
	eq(planNoFb.skips.filter(s => /^C1[1-6]$/.test(s.designator) && s.reason === 'blocked').length, 10, '关闭回退后中间 10 个 blocked');

	// 宽松模式：忽略间距预检查（防重叠 ~2mil），原 blocked 的中间焊盘也能打上
	const planRelaxed = planOf({ fallbackViaDiameterMm: 0, fallbackViaHoleMm: 0, relaxedMode: true });
	const bankRelaxed = planRelaxed.items.filter(it => /^C1[1-6]$/.test(it.pad.designator));
	eq(bankRelaxed.length, 12, '宽松模式下 0402 全部 12 个焊盘打上（45° 斜向可进）');
	eq(planRelaxed.skips.filter(s => /^C1[1-6]$/.test(s.designator) && s.reason === 'blocked').length, 0, '宽松模式下 0402 无 blocked');
	// 防重叠底线仍生效：新过孔两两不重叠且都在板内
	for (const v of planRelaxed.items.map(it => it.via)) {
		ok(insideBoard(v.x, v.y, buildFixture().outline, v.diameter / 2), `宽松模式过孔(${v.x.toFixed(0)},${v.y.toFixed(0)}) 仍在板内`);
	}

	// 每焊盘至多一个过孔（全局）
	const seen = new Set<string>();
	for (const it of plan.items) {
		const key = `${it.pad.designator}-${it.pad.padNumber}`;
		ok(!seen.has(key), `焊盘 ${key} 不重复打孔`);
		seen.add(key);
	}
}

/* ---------------- 3. 避让与 DRC 前置校验 ---------------- */

function testAvoidance(): void {
	console.log('\n[3] 位置避让（板边/障碍/走线分层）');
	const fixture = buildFixture();
	const cfg = { ...DEFAULT_CONFIG };
	const plan = planFanout(fixture, cfg);
	const clr = mm(cfg.clearanceMm);

	// 全部过孔：板内 + 与所有既有障碍保持间距（源焊盘豁免：stub=0 时过孔贴其边界）
	for (const item of plan.items) {
		const v = item.via;
		const vr = v.diameter / 2; // 主过孔或回退小过孔
		ok(insideBoard(v.x, v.y, fixture.outline, clr + vr), `过孔(${v.x.toFixed(0)},${v.y.toFixed(0)}) 在板内且距板边足够`);
		for (const p of fixture.pads) {
			if (p.designator === item.pad.designator && p.padNumber === item.pad.padNumber)
				continue; // 源焊盘：同网络就近贴合，不按 clearance 校验
			const gap = pointPadClearance(v.x, v.y, p) - vr;
			ok(gap >= clr - 0.01, `过孔 ${v.net} 与焊盘 ${p.designator}-${p.padNumber}(${p.net}) 间距 ${gap.toFixed(1)}mil >= ${clr.toFixed(1)}mil`);
		}
		for (const ev of fixture.vias) {
			const gap = circleClearance(v.x, v.y, vr, ev.x, ev.y, ev.diameter / 2);
			ok(gap >= clr - 0.01, `过孔 ${v.net} 与既有过孔 ${ev.net} 间距 ${gap.toFixed(1)}mil`);
		}
		for (const t of fixture.tracks) {
			const gap = capsuleCircleClearance(t.x1, t.y1, t.x2, t.y2, t.width, v.x, v.y, vr);
			ok(gap >= clr - 0.01, `过孔 ${v.net} 与走线 ${t.net} 间距 ${gap.toFixed(1)}mil`);
		}
	}
	// 新过孔两两间距
	const plannedVias = plan.items.map(it => it.via);
	for (let i = 0; i < plannedVias.length; i++) {
		for (let j = i + 1; j < plannedVias.length; j++) {
			const a = plannedVias[i];
			const b = plannedVias[j];
			ok(circleClearance(a.x, a.y, a.diameter / 2, b.x, b.y, b.diameter / 2) >= clr - 0.01, `新过孔 ${a.net}/${b.net} 两两间距足够`);
		}
	}

	// 直线方向优先：0° 可用时即选直线（45° 斜向仅后备）
	const c1v = itemsOf(plan, 'C1')[0];
	ok(!!c1v, 'C1 3V3 有过孔');
	eq(c1v?.directionDeg, 0, 'C1-3V3 0° 直线方向可用即选直线');
	const r9v2 = itemsOf(plan, 'R9').find(it => it.pad.padNumber === '2');
	eq(r9v2?.directionDeg, 0, 'R9-2 0° 与 45° 均可用时优先直线');

	// 0°/90° 过孔被阻挡时仍走直线（180°）
	const t1 = itemsOf(plan, 'T1')[0];
	const t2 = itemsOf(plan, 'T2')[0];
	eq(t1?.directionDeg, 180, 'T1(顶层) 0°/90° 过孔被走线阻挡，改走 180° 直线');
	eq(t2?.directionDeg, 180, 'T2(底层) 0°/90° 过孔被阻挡，走 180°；顶层走线不构成底层连线障碍');
	eq(t1?.track.layer, 1, 'T1 连线在顶层');
	eq(t2?.track.layer, 2, 'T2 连线在底层');

	// 同层走线挡连线通道（过孔位置本身放行）
	const t3 = itemsOf(plan, 'T3')[0];
	eq(t3?.directionDeg, 180, 'T3(底层) 0° 仅连线通道被同层走线阻挡，改走 180°');

	// 板边压边焊盘：不整体跳过，向板内仍打出过孔
	const t4 = itemsOf(plan, 'T4')[0];
	ok(!!t4, 'T4(压板边) 仍有打孔（不因压板边整体跳过）');
	if (t4) {
		ok(insideBoard(t4.via.x, t4.via.y, fixture.outline, clr + t4.via.diameter / 2), 'T4 过孔在板内');
		ok(t4.via.x > 0, 'T4 过孔在板内侧');
	}

	// 连线通道：过孔-焊盘连线与异网络铜不冲突（按层校验）
	for (const it of plan.items) {
		const t = it.track;
		if (!t)
			continue; // 盘中孔项无连线
		for (const p of fixture.pads) {
			if (p.net === t.net || p.layer !== t.layer)
				continue;
			// 采样连线段检查与焊盘外接盒的最小距离
			for (let s = 0; s <= 10; s++) {
				const px = t.x1 + ((t.x2 - t.x1) * s) / 10;
				const py = t.y1 + ((t.y2 - t.y1) * s) / 10;
				const gap = distPointSeg(px, py, p.x - p.sizeX / 2, p.y, p.x + p.sizeX / 2, p.y) - t.width / 2;
				ok(gap >= clr - 0.01, `${it.pad.designator}-${it.pad.padNumber} 连线与焊盘 ${p.designator}(${p.net}) 间距足够`);
			}
		}
	}

	// 板角 C9：所有过孔仍在板内（已在上面全局校验），并确认两个焊盘都有孔
	eq(itemsOf(plan, 'C9').length, 2, 'C9 板角两焊盘均打过孔');
}

/* ---------------- 4. 线宽与就近距离 ---------------- */

function testDimensions(): void {
	console.log('\n[4] 线宽（不超过焊盘尺寸）与就近距离（阻焊边界 + stub）');
	const cfg = { ...DEFAULT_CONFIG }; // traceWidthMm 0.4, stub 0, useSolderMask true
	const fixture = buildFixture();
	const plan = planFanout(fixture, cfg);
	const stubMil = mm(cfg.stubMm);
	const userW = mm(cfg.traceWidthMm);

	for (const it of plan.items) {
		if (!it.track)
			continue; // 盘中孔项无连线
		const padMin = Math.min(it.pad.sizeX, it.pad.sizeY);
		const viaRIt = it.via.diameter / 2; // 主过孔或回退小过孔
		ok(it.track.width <= padMin + 0.001, `${it.pad.designator}-${it.pad.padNumber} 线宽 ${it.track.width.toFixed(1)}mil <= 焊盘尺寸 ${padMin.toFixed(1)}mil`);
		eq(it.track.width, Math.min(userW, padMin), `${it.pad.designator}-${it.pad.padNumber} 线宽 = min(设定, 焊盘尺寸)`);
		// 过孔与连线同网络、过孔中心即连线终点
		eq(it.track.x2, it.via.x, '连线终点 = 过孔中心 x');
		eq(it.track.y2, it.via.y, '连线终点 = 过孔中心 y');
		eq(it.via.net, it.pad.net, '过孔网络 = 焊盘网络');
		// 就近距离：step=0 时 过孔边缘贴焊盘边界（阻焊开窗边缘 + stub）
		if (it.searchStep === 0) {
			const srcPad = fixture.pads.find(p => p.designator === it.pad.designator && p.padNumber === it.pad.padNumber)!;
			const rad = (it.directionDeg * Math.PI) / 180;
			const gapMasked = it.distanceMil - padExtent(srcPad, rad, true) - viaRIt;
			ok(Math.abs(gapMasked - stubMil) < 0.5, `${it.pad.designator}-${it.pad.padNumber} 过孔边缘贴边界（阻焊+stub）余量 ${(gapMasked * 0.0254).toFixed(3)}mm ≈ ${cfg.stubMm}mm`);
			// 有阻焊扩展的焊盘：过孔边缘距铜皮边缘 ≈ 阻焊扩展（在间距规则内就近）
			if ((srcPad.maskExpansionMil ?? 0) > 0) {
				const gapCopper = it.distanceMil - padExtent(srcPad, rad, false) - viaRIt;
				ok(Math.abs(gapCopper - (srcPad.maskExpansionMil ?? 0)) < 0.5, `${it.pad.designator}-${it.pad.padNumber} 过孔边缘距铜皮边缘 ≈ 阻焊扩展 ${(gapCopper * 0.0254).toFixed(3)}mm`);
			}
		}
	}

	// 线宽自动模式：0 -> min(焊盘, 该项过孔外径)
	const planAuto = planFanout(fixture, { ...DEFAULT_CONFIG, traceWidthMm: 0 });
	for (const it of planAuto.items) {
		const padMin = Math.min(it.pad.sizeX, it.pad.sizeY);
		eq(it.track.width, Math.min(padMin, it.via.diameter), `自动线宽 ${it.pad.designator}-${it.pad.padNumber}`);
	}

	// 大线宽设定被焊盘钳制：8mil 焊盘 x 8mil
	const planWide = planFanout(fixture, { ...DEFAULT_CONFIG, traceWidthMm: 2 });
	for (const it of planWide.items) {
		const padMin = Math.min(it.pad.sizeX, it.pad.sizeY);
		eq(it.track.width, padMin, `超宽设定被钳制到焊盘尺寸 ${it.pad.designator}-${it.pad.padNumber}`);
	}

	// 关闭阻焊边界：过孔直接贴焊盘铜皮边缘（间距规则内就近）
	const planNoMask = planFanout(fixture, { ...DEFAULT_CONFIG, useSolderMask: false });
	for (const it of itemsOf(planNoMask, 'J1')) {
		const srcPad = fixture.pads.find(p => p.designator === 'J1' && p.padNumber === it.pad.padNumber)!;
		const gap = it.distanceMil - padExtent(srcPad, (it.directionDeg * Math.PI) / 180, false) - it.via.diameter / 2;
		ok(Math.abs(gap) < 0.5, `关闭阻焊边界后 J1-${it.pad.padNumber} 过孔贴铜皮边缘`);
	}
}

/* ---------------- 5. applyPlan 写回（模拟 hooks） ---------------- */

interface SimRecord {
	viaCalls: Array<{ net: string; x: number; y: number; hole: number; dia: number }>;
	lineCalls: Array<{ net: string; layer: number; w: number }>;
	deleted: string[];
}

function makeSimHooks(opts: { drcBase?: number; drcNew?: number; failLineOn?: string } = {}): { hooks: ApplyHooks; sim: SimRecord } {
	const sim: SimRecord = { viaCalls: [], lineCalls: [], deleted: [] };
	let drcCalls = 0;
	let seq = 0;
	const hooks: ApplyHooks = {
		async createVia(v) {
			sim.viaCalls.push({ net: v.net, x: v.x, y: v.y, hole: v.holeDiameter, dia: v.diameter });
			return `v${++seq}`;
		},
		async createLine(t) {
			if (opts.failLineOn && `${t.x1},${t.y1}` === opts.failLineOn)
				return undefined; // 模拟该条连线创建失败
			sim.lineCalls.push({ net: t.net, layer: t.layer, w: t.width });
			return `l${++seq}`;
		},
		async deletePrimitives(ids) {
			sim.deleted.push(...ids);
			return true;
		},
		async drcViolations() {
			drcCalls++;
			// 第一次调用（创建前）返回基线；之后每次返回基线+新增
			return Array.from({ length: (opts.drcBase ?? 0) + (drcCalls > 1 ? (opts.drcNew ?? 0) : 0) }, (_, i) => `v${i}`);
		},
	};
	return { hooks, sim };
}

async function testApply(): Promise<void> {
	console.log('\n[5] applyPlan 写回与 DRC 回滚');
	// 存储桩：applyPlan 成功后会把创建 ID 持久化到 eda.sys_Storage
	const store = new Map<string, string>();
	(globalThis as any).eda = {
		sys_Storage: {
			getExtensionUserConfig: (k: string) => store.get(k),
			setExtensionUserConfig: async (k: string, v: string) => {
				store.set(k, v);
			},
		},
	};
	const plan = planOf();

	// 5.1 正常写回 + DRC 通过
	const s1 = makeSimHooks({ drcBase: 3, drcNew: 0 });
	const r1 = await applyPlan(plan, { ...DEFAULT_CONFIG }, s1.hooks);
	eq(r1.applied, plan.items.length, `正常写回 applied=${plan.items.length}`);
	eq(r1.failed, 0, '无失败项');
	ok(r1.drcChecked, '执行了 DRC 校验');
	eq(r1.newViolations, 0, 'DRC 新增违规 0');
	eq(r1.rolledBack, false, '未回滚');
	eq(s1.sim.viaCalls.length, plan.items.length, '过孔创建调用数 = 计划数');
	eq(s1.sim.lineCalls.length, plan.items.length, '连线创建调用数 = 计划数');
	ok(s1.sim.viaCalls.every((c) => {
		const main = Math.abs(c.hole - mm(DEFAULT_CONFIG.viaHoleMm)) < 0.01 && Math.abs(c.dia - mm(DEFAULT_CONFIG.viaDiameterMm)) < 0.01;
		const fb = Math.abs(c.hole - mm(DEFAULT_CONFIG.fallbackViaHoleMm)) < 0.01 && Math.abs(c.dia - mm(DEFAULT_CONFIG.fallbackViaDiameterMm)) < 0.01;
		return main || fb;
	}), '过孔尺寸参数正确（主 0.3/0.6 或回退 0.2/0.4）');
	ok(s1.sim.deleted.length === 0, '无删除');

	// 创建 ID 已持久化（供一键清理）
	const saved = JSON.parse(store.get('fanoutCreatedIds') ?? '{}');
	eq((saved.vias ?? []).length, plan.items.length, '过孔 ID 持久化');
	eq((saved.lines ?? []).length, plan.items.length, '连线 ID 持久化');

	// 5.2 DRC 新增违规 -> 全量回滚
	const s2 = makeSimHooks({ drcBase: 2, drcNew: 5 });
	const r2 = await applyPlan(plan, { ...DEFAULT_CONFIG }, s2.hooks);
	eq(r2.rolledBack, true, 'DRC 新增违规触发回滚');
	eq(r2.applied, 0, '回滚后 applied=0');
	eq(r2.newViolations, 5, '新增违规数记录');
	eq(s2.sim.deleted.length, plan.items.length * 2, '回滚删除全部过孔+连线');
	eq(r2.createdViaIds.length, 0, '回滚后无残留 ID');

	// 5.3 单项连线失败 -> 仅该项过孔回滚
	const failPad = plan.items[0];
	const s3 = makeSimHooks({ failLineOn: `${failPad.track!.x1},${failPad.track!.y1}` });
	const r3 = await applyPlan(plan, { ...DEFAULT_CONFIG, useDrcCheck: false }, s3.hooks);
	eq(r3.failed, 1, '1 项失败');
	eq(r3.applied, plan.items.length - 1, '其余项成功');
	eq(s3.sim.deleted.length, 1, '失败项过孔被删除');
	ok(s3.sim.deleted[0]?.startsWith('af-via:'), '删除的是过孔 ID 前缀');

	// 5.4 关闭 DRC 校验
	const s4 = makeSimHooks();
	const r4 = await applyPlan(plan, { ...DEFAULT_CONFIG, useDrcCheck: false }, s4.hooks);
	ok(!r4.drcChecked, '关闭后不做 DRC 校验');
	eq(r4.applied, plan.items.length, '关闭 DRC 不影响写回');

	// 5.5 宽松模式自动跳过 DRC 后校验（即使 useDrcCheck 开着）
	const s5 = makeSimHooks({ drcBase: 0, drcNew: 99 });
	const r5 = await applyPlan(plan, { ...DEFAULT_CONFIG, relaxedMode: true }, s5.hooks);
	ok(!r5.drcChecked, '宽松模式自动跳过 DRC 后校验');
	eq(r5.applied, plan.items.length, '宽松模式不回滚，全部写回');
	eq(r5.rolledBack, false, '宽松模式无回滚');

	// 5.6 盘中孔计划：无连线项只创建过孔
	const planVIP = planOf({ viaInPad: true, clearanceMm: 0.1 });
	const s6 = makeSimHooks();
	const r6 = await applyPlan(planVIP, { ...DEFAULT_CONFIG, viaInPad: true, clearanceMm: 0.1, useDrcCheck: false }, s6.hooks);
	eq(r6.applied, planVIP.items.length, '盘中孔计划全部写回');
	eq(s6.sim.viaCalls.length, planVIP.items.length, '过孔创建数 = 计划项数');
	eq(s6.sim.lineCalls.length, planVIP.items.filter(it => it.track).length, '连线创建数 = 有连线的项数');
}

/* ---------------- 6. parsePad 焊盘识别（模拟 EDA 焊盘对象） ---------------- */

/** 构造模拟 EDA 焊盘图元 */
function simPin(opts: {
	net?: string;
	hole?: unknown;
	metallization?: boolean;
	mask?: { top?: number; bottom?: number } | null;
	layer?: number;
	shape?: unknown;
}): any {
	return {
		getState_Net: () => opts.net ?? 'GND',
		getState_X: () => 1000,
		getState_Y: () => 2000,
		getState_PadNumber: () => '1',
		getState_Layer: () => opts.layer ?? 1,
		getState_Pad: () => opts.shape ?? ['RECT', 40, 60],
		getState_Hole: () => opts.hole ?? null,
		getState_Metallization: () => opts.metallization ?? true,
		getState_SolderMaskAndPasteMaskExpansion: () => opts.mask ?? null,
	};
}

function testParsePad(): void {
	console.log('\n[6] parsePad 焊盘识别');
	// 直插判定：仅孔数组且孔径 > 0 才算
	eq(parsePad(simPin({ hole: ['ROUND', 12] }), 'c', 'U1', 2)?.hasHole, true, 'ROUND 孔径>0 -> 直插');
	eq(parsePad(simPin({ hole: ['SLOT', 12, 30] }), 'c', 'U1', 2)?.hasHole, true, 'SLOT 孔 -> 直插');
	eq(parsePad(simPin({ hole: ['ROUND', 12], metallization: false }), 'c', 'U1', 2)?.hasHole, false, '孔数据脏 + 明确非金属化 -> 非直插（金属化交叉校验）');
	eq(parsePad(simPin({ hole: ['ROUND', 12], metallization: undefined }), 'c', 'U1', 2)?.hasHole, true, '金属化信息缺失 -> 保守按直插');
	eq(parsePad(simPin({ hole: null }), 'c', 'U1', 2)?.hasHole, false, 'hole=null (SMT) -> 非直插');
	eq(parsePad(simPin({ hole: [] }), 'c', 'U1', 2)?.hasHole, false, 'hole=[] 空数组 -> 非直插（防整封装误判）');
	eq(parsePad(simPin({ hole: ['ROUND', 0] }), 'c', 'U1', 2)?.hasHole, false, 'ROUND 孔径=0 -> 非直插');
	eq(parsePad(simPin({ hole: 'ROUND' }), 'c', 'U1', 2)?.hasHole, false, 'hole=字符串 -> 非直插');
	// 孔径记录（焊环甄别用）与原始层值（多层甄别用）
	eq(parsePad(simPin({ hole: ['ROUND', 12] }), 'c', 'U1', 2)?.holeExtentMil, 12, 'ROUND 孔径记录到 holeExtentMil');
	eq(parsePad(simPin({ hole: ['SLOT', 12, 30] }), 'c', 'U1', 2)?.holeExtentMil, 30, 'SLOT 取槽长最大值');
	eq(parsePad(simPin({ hole: ['ROUND', 12], metallization: false }), 'c', 'U1', 2)?.holeExtentMil, 0, '非金属化不记孔径');
	eq(parsePad(simPin({ layer: 12, hole: ['ROUND', 12] }), 'c', 'U1', 2)?.rawLayer, 12, 'rawLayer 保留原始层值（12=多层）');
	eq(parsePad(simPin({ layer: 12, hole: ['ROUND', 12] }), 'c', 'U1', 2)?.layer, 1, '多层(12) 的 layer 归一为顶层');
	// 阻焊扩展：按层取值 + 脏数据钳位
	eq(parsePad(simPin({ mask: { topSolderMask: 4 } }), 'c', 'U1', 2)?.maskExpansionMil, 4, '顶层焊盘取 topSolderMask');
	eq(parsePad(simPin({ mask: { bottomSolderMask: 5 }, layer: 2 }), 'c', 'U1', 2)?.maskExpansionMil, 5, '底层焊盘取 bottomSolderMask');
	eq(parsePad(simPin({ mask: null }), 'c', 'U1', 2)?.maskExpansionMil, 0, '无阻焊扩展 -> 0（贴铜皮边缘）');
	eq(parsePad(simPin({ mask: { topSolderMask: 9999 } }), 'c', 'U1', 2)?.maskExpansionMil, 50, '异常大阻焊值钳位 50mil');
	// 无网络焊盘：跳过
	eq(parsePad(simPin({ net: '' }), 'c', 'U1', 2), undefined, '无网络焊盘返回 undefined');
	// 形状缺失：默认尺寸兜底
	const p = parsePad(simPin({ shape: undefined }), 'c', 'U1', 2);
	eq(p?.sizeX, 40, '形状缺失默认 sizeX=40mil');
}

/* ---------------- 7. 报告摘要 ---------------- */

function testSummary(): void {
	console.log('\n[7] 报告摘要');
	const plan = planOf();
	const s = planSummary(plan);
	ok(s.includes(`计划打孔 ${plan.items.length} 个`), '摘要含打孔数');
	ok(s.includes('B1(256p)'), '摘要含 BGA 忽略');
	ok(s.includes('直插孔焊盘跳过（本身是孔）：2'), '摘要含直插跳过数', s);
	ok(s.includes('已有就近过孔跳过：1'), '摘要含合并跳过数', s);
	ok(s.includes('J2：直插孔×2'), '摘要含按器件未打孔原因', s);
	ok(s.includes('回退小过孔'), '摘要含回退小过孔计数', s);
}

/* ---------------- 8. 直插脏孔甄别 与 盘中孔 ---------------- */

function testThtSuspectsAndViaInPad(): void {
	console.log('\n[8] 直插脏孔三重甄别与盘中孔');
	const plan = planOf();

	// 脏孔甄别：真直插仅 J2（多层 + 全孔 + 焊环全过）；各脏孔形态全部按贴片处理
	eq(plan.stats.tht, 2, '真直插跳过仅 J2 两个焊盘');
	eq(plan.stats.thtSuspect, 8, '疑似直插误判 8 个（C20×1、C21×1、H6×2、H7×2、J3×2）');
	for (const key of ['C20-2', 'C21-2', 'H6-1', 'H6-2', 'H7-1', 'H7-2', 'J3-1', 'J3-2'])
		ok(plan.thtSuspects.includes(key), `疑似清单含 ${key}`);
	eq(itemsOf(plan, 'C20').length, 2, 'C20 单侧脏大孔（塞不进焊盘）-> 两焊盘都打孔');
	eq(itemsOf(plan, 'C21').length, 2, 'C21 单侧脏小孔（几何放得进）-> 器件共识甄别后打孔');
	eq(itemsOf(plan, 'H6').length, 2, 'H6 全孔但单层（真直插必为多层 12）-> 按贴片打孔');
	eq(itemsOf(plan, 'H7').length, 2, 'H7 多层全孔但孔塞不进焊盘 -> 按贴片打孔');
	eq(itemsOf(plan, 'J3').length, 2, 'J3 定位脚部分带孔 -> 按贴片打孔（信号脚不参与）');
	ok(planSummary(plan).includes('疑似直插误判已按贴片处理：8'), '摘要含疑似直插误判行', planSummary(plan));

	// skipThiPads=false 逃生开关：J2 也打孔，且不再产生疑似统计
	const planNoTht = planOf({ skipThiPads: false });
	eq(itemsOf(planNoTht, 'J2').length, 2, 'skipThiPads=false 时 J2 直插焊盘也打孔');
	eq(planNoTht.stats.thtSuspect, 0, '关闭判定后无疑似统计');

	// 盘中孔：大焊盘主过孔中心直放；0402 放不下主过孔 -> 回退小过孔中心直放。
	// （间距用 0.1：0402 同件两焊盘中心距 0.9mm，0.4 过孔边距恰为 0.15mm，
	//   与默认间距 0.15 相等会踩浮点临界，降到 0.1 留出余量）
	const planVIP = planOf({ viaInPad: true, clearanceMm: 0.1 });
	const c12 = itemsOf(planVIP, 'C1').find(it => it.pad.padNumber === '2');
	ok(!!c12?.viaInPad, 'C1-2 盘中孔');
	ok(c12?.distanceMil === 0 && c12?.track === undefined, '盘中孔距离 0 且无连线');
	ok(Math.abs((c12?.via.x ?? -1) - mm(15.8)) < 0.01, '过孔在焊盘中心');
	ok(Math.abs((c12?.via.diameter ?? 0) - mm(0.6)) < 0.01, '大焊盘用主过孔');
	ok(itemsOf(planVIP, 'J1').every(it => it.viaInPad), 'J1 大焊盘中心直放');
	const bankVIP = planVIP.items.filter(it => /^C1[1-6]$/.test(it.pad.designator));
	eq(bankVIP.length, 12, '0402 阵列 12 焊盘全打');
	ok(bankVIP.every(it => it.viaInPad && it.usedFallback && it.track === undefined), '0402 主过孔放不进 -> 回退小过孔中心直放');
	const t4v = itemsOf(planVIP, 'T4')[0];
	ok(!!t4v && !t4v.viaInPad && t4v.distanceMil > 0 && !!t4v.track, 'T4 中心在板外 -> 自动回退就近搜索');
	eq(itemsOf(planVIP, 'J2').length, 0, 'J2 真直插在盘中孔模式下仍跳过');
	eq(planVIP.stats.viaInPad, planVIP.items.filter(it => it.viaInPad).length, 'stats.viaInPad 计数一致');
	ok(planSummary(planVIP).includes('为盘中孔（焊盘中心直放）'), '摘要含盘中孔行', planSummary(planVIP));
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
	testNetClassify();
	testPlan();
	testAvoidance();
	testDimensions();
	await testApply();
	testParsePad();
	testSummary();
	testThtSuspectsAndViaInPad();

	console.log(`\n================ 结果 ================`);
	if (failures) {
		console.error(`❌ ${failures}/${checks} 项断言失败`);
		process.exit(1);
	}
	console.log(`✅ 全部 ${checks} 项断言通过`);
}

// 测试运行器需要顶层 await 驱动 async 主流程
// eslint-disable-next-line antfu/no-top-level-await
await main();
