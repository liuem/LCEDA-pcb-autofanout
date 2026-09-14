/**
 * 电源/地网络识别 / Power & ground net classification
 *
 * 规则分两层：
 * 1. 内置规则（可关）：GND 词族 + 电压词族（VCC/VDD/VBUS/3V3/+5V…）
 * 2. 用户自定义（netPatterns，逗号分隔）：忽略大小写整词或包含匹配
 */
import type { NetClass } from './types.ts';

/** GND 词族：GND/AGND/PGND/DGND/EGND/SGND/GND1/GND_PLL/GROUND/EARTH/Earth… */
const GROUND_TOKEN_RE = /^(?:[A-Z]*GND[A-Z0-9]*|GROUND|EARTH)$/i;

/** 显式电压前缀：VCC/VDD/VEE/VBAT/VBUS/VIN/VOUT/VSYS/VDDA/VCCA/VREF/VPP/VDDIO… */
const POWER_TOKEN_RE = /^(?:V[DCE][A-Z0-9]*|VPP|VBAT|VBUS|VIN|VOUT|VSYS|VREG|VLDO|VM|VP|VREF)$/i;

/** 数字电压形态：5V/3V3/1V8/2V5/12V/5V0/3.3V/1.2V，可带 +/- 前缀或 V/VA 后缀 */
const POWER_VOLT_RE = /^[+-]?\d+(?:\.\d+)?V\d*(?:A|P)?$/i;

/** 带正负号的网络：+5V/+3V3/+BATT/-5V */
const SIGNED_POWER_RE = /^[+-].*$/;

/** 常见应排除的“伪电源”网络名 */
const EXCLUDE_RE = /^(?:VUSB_SENSE_NC|VCORE_FET_SHHN)$/i;

/** 拆分网络名中的词元：GND_PLL -> [GND, PLL]；+3V3 -> [+3V3]；USB_DP -> [USB, DP] */
function tokens(net: string): string[] {
	return net.split(/[_\-\s+/]+/).filter(Boolean);
}

/** 内置分类器：只看单网络名，返回 power/ground/signal */
export function classifyBuiltIn(net: string): NetClass {
	const name = net.trim();
	if (!name || EXCLUDE_RE.test(name))
		return 'signal';

	for (const tok of tokens(name)) {
		if (GROUND_TOKEN_RE.test(tok))
			return 'ground';
	}

	// 整名先匹配电压形态（+5V/3V3/3.3V）
	if (POWER_VOLT_RE.test(name))
		return 'power';
	if (SIGNED_POWER_RE.test(name) && /BATT|BAT|V|\d/i.test(name.slice(1)))
		return 'power';

	for (const tok of tokens(name)) {
		if (POWER_TOKEN_RE.test(tok))
			return 'power';
		if (POWER_VOLT_RE.test(tok))
			return 'power';
	}
	return 'signal';
}

/** 解析用户自定义网络模式串（逗号/分号/空白分隔） */
export function parseNetPatterns(patterns: string): string[] {
	return patterns
		.split(/[,;，；\s]+/)
		.map(p => p.trim())
		.filter(p => p.length > 0);
}

/**
 * 综合分类器。
 * @param net 网络名
 * @param opts 选项
 * @param opts.useBuiltin 是否叠加内置规则
 * @param opts.patterns 用户自定义模式列表
 * @param opts.includePower 是否接受电源类
 * @param opts.includeGround 是否接受地类
 */
export function classifyNet(
	net: string,
	opts: { useBuiltin?: boolean; patterns?: string[]; includePower?: boolean; includeGround?: boolean } = {},
): NetClass {
	const includePower = opts.includePower !== false;
	const includeGround = opts.includeGround !== false;

	// 用户自定义优先：整词（忽略大小写）或包含（模式长度 >= 2 防误匹配）。
	// 命中后按模式自身归类：GND* -> ground，其余（含无法识别的）-> power
	for (const p of opts.patterns ?? []) {
		if (p.length < 2)
			continue;
		const lower = net.toLowerCase();
		if (lower === p.toLowerCase() || lower.includes(p.toLowerCase())) {
			if (isGroundLike(p) && includeGround)
				return 'ground';
			return includePower ? 'power' : 'signal';
		}
	}

	const built = opts.useBuiltin === false ? 'signal' : classifyBuiltIn(net);
	if (built === 'ground' && includeGround)
		return 'ground';
	if (built === 'power' && includePower)
		return 'power';
	return 'signal';
}

/** 模式本身是否更像地网络（用户写 GND* 时归为地） */
function isGroundLike(pattern: string): boolean {
	return classifyBuiltIn(pattern) === 'ground';
}
