import type { FanoutConfig, FanoutPlan } from './types.ts';
/**
 * 电源地就近打孔 扩展入口 / Entry
 *
 * 交互使用 sys_Dialog（与 ai-pcb-autoplace 相同的已验证 API）：
 * - 一键打孔：提取 -> 规划 -> 写回 -> DRC 后校验（新增违规自动回滚）
 * - 预览：只规划不写回，报告将打孔的位置明细
 * - 清理：删除本插件历史创建的过孔/连线
 * - 诊断：把每个电源/地焊盘的原始数据与去向输出到控制台
 * - 设置面板：iframe 图形界面（改动即自动保存）
 */
import { applyPlan, cleanupCreated, createEdaHooks, extractBoardState, loadConfig } from './eda-adapter.ts';
import { classifyNet, parseNetPatterns } from './net-classify.ts';
import { planFanout, planSummary } from './planner.ts';
import { MM_TO_MIL } from './types.ts';

declare const eda: any;

/* ---------------- 对话框 Promise 封装 ---------------- */

function askConfirm(content: string, title: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, '确定', '取消', (main: boolean) => resolve(main));
	});
}

function toast(msg: string): void {
	eda.sys_ToastMessage.showMessage(msg, 0 /* INFO */);
}

/* ---------------- 设置面板 ---------------- */

function fmtMm(v: number): string {
	return `${v} mm`;
}

function configSummary(cfg: FanoutConfig): string {
	return [
		`网络：${cfg.includeGround ? '地(GND 族)' : '地✗'} + ${cfg.includePower ? '电源(VCC/3V3/+5V…)' : '电源✗'}${cfg.netPatterns ? ` + 自定义[${cfg.netPatterns}]` : ''}`,
		`过孔：孔 ${fmtMm(cfg.viaHoleMm)} / 外径 ${fmtMm(cfg.viaDiameterMm)}${cfg.fallbackViaDiameterMm > 0 ? `（回退小过孔 ${fmtMm(cfg.fallbackViaHoleMm)}/${fmtMm(cfg.fallbackViaDiameterMm)}）` : '（回退关）'}`,
		`就近边界：${cfg.useSolderMask ? '阻焊开窗边缘' : '焊盘铜皮边缘'} + 额外余量 ${fmtMm(cfg.stubMm)}（0=贴合就近）`,
		`盘中孔：${cfg.viaInPad ? '开（过孔打在焊盘中心，无连线；放不下自动回退就近）' : '关'}`,
		`直插孔焊盘自动跳过：${cfg.skipThiPads ? '开（真直插：多层+全孔+焊环三重甄别，脏孔自动按贴片）' : '关（全部参与打孔）'}`,
		`方向优先：直线(0/90°)优先，45° 后备`,
		`连线宽度：${cfg.traceWidthMm > 0 ? fmtMm(cfg.traceWidthMm) : '自动'}（恒不超过焊盘尺寸）`,
		`忽略焊盘数超过 ${cfg.maxPins} 的器件（保护 BGA）`,
		`安全间距：${fmtMm(cfg.clearanceMm)} | 阻塞外扩步数：${cfg.maxSearchSteps}`,
		`重复打孔合并外扩：${cfg.mergeFactor} 个过孔外径 | DRC 后校验：${cfg.useDrcCheck ? '开' : '关'}`,
		`宽松模式：${cfg.relaxedMode ? '开（忽略间距预检查，可能引入 DRC 违规）' : '关'}`,
	].join('\n');
}

/** 设置面板（iframe 图形界面，经 eda.sys_Storage 共享存储直接读写配置） */
export async function openSettingsPanel(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/settings.html', 560, 640, 'autofanout-settings', {
		maximizeButton: false,
		minimizeButton: true,
		title: '打孔设置',
	});
}

/* ---------------- 主流程 ---------------- */

function detailLines(plan: FanoutPlan, limit = 30): string {
	const rows = plan.items.slice(0, limit).map((it) => {
		const head = `${it.pad.designator}-${it.pad.padNumber} ${it.via.net}`;
		if (it.viaInPad || !it.track)
			return `${head}: 盘中孔（中心${it.usedFallback ? '，回退小过孔' : ''}）`;
		const dir = `${it.directionDeg}°${it.searchStep > 0 ? `(+${it.searchStep}步)` : ''}`;
		return `${head}: ${dir} 距离 ${(it.distanceMil * 0.0254).toFixed(2)}mm 线宽 ${(it.track.width * 0.0254).toFixed(2)}mm`;
	});
	const more = plan.items.length > limit ? `\n… 共 ${plan.items.length} 项` : '';
	return rows.join('\n') + more;
}

/** 规划 + 报告（预览与执行共用） */
async function buildPlan(onProgress?: (pct: number, msg: string) => void): Promise<FanoutPlan> {
	const state = await extractBoardState(onProgress);
	onProgress?.(70, '规划打孔位置…');
	const cfg = loadConfig();
	return planFanout(state, cfg);
}

/** 预览：不修改画布 */
export async function previewFanout(): Promise<void> {
	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析板面…');
	try {
		const cfg = loadConfig();
		const plan = await buildPlan((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		eda.sys_Dialog.showInformationMessage(
			`${planSummary(plan, cfg.relaxedMode)}\n\n明细：\n${detailLines(plan)}\n\n（预览未修改画布，执行「一键打孔」生效）`,
			'打孔预览',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		eda.sys_Dialog.showInformationMessage(`预览失败：${e instanceof Error ? e.message : String(e)}`, '打孔预览');
	}
}

/** 一键打孔 */
export async function runFanout(): Promise<void> {
	const cfg = loadConfig();
	if (!(await askConfirm(
		`将对电源/地网络焊盘就近打过孔 + 连线。\n\n${configSummary(cfg)}\n\n建议先「预览」确认。继续？`,
		'电源地就近打孔',
	))) {
		return;
	}

	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '分析板面…');
	try {
		const plan = await buildPlan((pct, msg) => eda.sys_LoadingAndProgressBar.showProgressBar(pct, msg));
		if (!plan.items.length) {
			eda.sys_LoadingAndProgressBar.destroyProgressBar();
			eda.sys_Dialog.showInformationMessage(`没有可打孔的焊盘。\n\n${planSummary(plan)}`, '电源地就近打孔');
			return;
		}

		const result = await applyPlan(plan, cfg, createEdaHooks(), (done, total, msg) =>
			eda.sys_LoadingAndProgressBar.showProgressBar(70 + Math.round((done / Math.max(total, 1)) * 25), msg));
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		if (result.rolledBack) {
			eda.sys_Dialog.showInformationMessage(
				`DRC 检出新增违规 ${result.newViolations} 处，已自动回滚本次创建的全部过孔/连线。\n\n建议：增大安全间距或伸出距离后重试，或关闭 DRC 后校验分批执行。`,
				'DRC 校验未通过',
			);
			return;
		}

		const drcNote = result.drcChecked
			? `\nDRC 后校验通过（新增违规 0）`
			: cfg.relaxedMode
				? '\n宽松模式：已跳过 DRC 后校验'
				: '\n（DRC 接口不可用，已跳过后校验）';
		eda.sys_Dialog.showInformationMessage(
			`完成：成功打孔 ${result.applied} 个${result.failed ? `，失败 ${result.failed} 个` : ''}。${drcNote}\n\n${planSummary(plan, cfg.relaxedMode)}\n\n明细：\n${detailLines(plan)}`,
			'电源地就近打孔',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		eda.sys_Dialog.showInformationMessage(
			`打孔失败：${e instanceof Error ? e.message : String(e)}\n\n提示：请确认已打开 PCB 编辑器且板内已有网络。`,
			'电源地就近打孔',
		);
	}
}

/** 删除本插件创建的过孔/连线 */
export async function cleanupFanout(): Promise<void> {
	if (!(await askConfirm('将删除本插件历史创建的全部过孔与连线（不影响手工布线），继续？', '清理')))
		return;
	try {
		const n = await cleanupCreated();
		toast(n.vias || n.lines ? `已删除过孔 ${n.vias} 个、连线 ${n.lines} 条` : '没有可清理的记录');
	}
	catch (e) {
		eda.sys_Dialog.showInformationMessage(`清理失败：${e instanceof Error ? e.message : String(e)}`, '清理');
	}
}

/**
 * 诊断：把每个电源/地焊盘的原始数据（尺寸/孔/金属化/阻焊/引脚数）与规划去向
 * 输出到控制台，用于排查"为什么这个封装没打孔"。明细可复制反馈给开发者。
 */
export async function dumpDiagnostics(): Promise<void> {
	eda.sys_LoadingAndProgressBar.showProgressBar(Number.NaN, '提取板面…');
	try {
		const cfg = loadConfig();
		const state = await extractBoardState();
		const plan = planFanout(state, cfg);
		eda.sys_LoadingAndProgressBar.destroyProgressBar();

		const classifyOpts = {
			useBuiltin: cfg.useBuiltinPatterns,
			patterns: parseNetPatterns(cfg.netPatterns),
			includePower: cfg.includePower,
			includeGround: cfg.includeGround,
		};
		const toMm = (mil: number) => (mil * 0.0254).toFixed(2);
		const lines: string[] = [];
		for (const pad of state.pads) {
			const cls = classifyNet(pad.net, classifyOpts);
			if (cls === 'signal' || !pad.net)
				continue;
			const item = plan.items.find(it => it.pad.designator === pad.designator && it.pad.padNumber === pad.padNumber);
			const skip = plan.skips.find(s => s.designator === pad.designator && s.padNumber === pad.padNumber);
			const dest = item
				? item.viaInPad
					? `打孔 盘中孔（中心）${item.usedFallback ? '（回退小过孔）' : ''}`
					: `打孔 ${item.directionDeg}° ${(item.distanceMil * 0.0254).toFixed(2)}mm${item.usedFallback ? '（回退小过孔）' : ''}`
				: skip
					? `跳过 ${skip.reason}${skip.detail ? `（${skip.detail}）` : ''}`
					: '未处理';
			const layerTxt = pad.rawLayer === 12 ? '多层' : pad.layer === 2 ? '底' : '顶';
			const holeTxt = pad.hasHole ? toMm(pad.holeExtentMil ?? 0) : '无';
			const suspect = plan.thtSuspects.includes(`${pad.designator}-${pad.padNumber}`);
			lines.push(
				`${pad.designator}-${pad.padNumber} net=${pad.net} class=${cls} pins=${pad.pinCount}`
				+ ` size=${toMm(pad.sizeX)}x${toMm(pad.sizeY)}mm layer=${layerTxt}`
				+ ` hole=${holeTxt}${suspect ? '（疑似脏数据->按贴片）' : ''} mask=${toMm(pad.maskExpansionMil ?? 0)}mm -> ${dest}`,
			);
		}
		console.log(`[autofanout] 诊断明细（${lines.length} 个电源/地焊盘）：\n${lines.join('\n')}`);
		eda.sys_Dialog.showInformationMessage(
			`诊断明细（${lines.length} 个电源/地焊盘）已输出到控制台。\n\n查看/复制：EDA Pro 菜单「设置 - 扩展 - 开发者工具」（或帮助菜单）打开 DevTools，Console 过滤 "autofanout"。\n\n汇总：\n${planSummary(plan, cfg.relaxedMode)}`,
			'诊断',
		);
	}
	catch (e) {
		eda.sys_LoadingAndProgressBar.destroyProgressBar();
		eda.sys_Dialog.showInformationMessage(`诊断失败：${e instanceof Error ? e.message : String(e)}`, '诊断');
	}
}

export function about(): void {
	const cfg = loadConfig();
	eda.sys_Dialog.showInformationMessage(
		`电源地就近打孔（LCEDA-pcb-autofanout）\n\n对电压/GND 网络焊盘 8 方向就近扇出过孔（可选盘中孔：焊盘中心直放）：位置通过板边/障碍间距预检查 + DRC 后校验双保险；真直插焊盘（多层+全孔+焊环三重甄别）自动跳过，封装脏孔数据自动按贴片处理；连线宽度自适应且不超过焊盘尺寸；超引脚数器件（BGA）自动忽略。\n\n当前配置：\n${configSummary(cfg)}\n\n单位换算：1mm = ${MM_TO_MIL.toFixed(2)}mil`,
		'关于',
	);
}
