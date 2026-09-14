/**
 * 数据模型与配置 / Data model & configuration
 *
 * 单位约定：内部统一使用 mil（EDA PCB 画布坐标单位）；
 * 用户配置以 mm 为单位输入，进入算法前换算。
 */

/** mm -> mil 换算系数 */
export const MM_TO_MIL = 1 / 0.0254;

export const LAYER_TOP = 1;
export const LAYER_BOTTOM = 2;
/** 铜层集合（顶层/底层/内层 15+） */
export function isCopperLayer(layer: number): boolean {
	return layer === LAYER_TOP || layer === LAYER_BOTTOM || layer >= 15;
}

export interface Point {
	x: number;
	y: number;
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export type NetClass = 'power' | 'ground' | 'signal';

/** 焊盘外形（与 EDA Pro TPCB_PrimitivePadShape 对应的简化模型） */
export type PadShapeKind = 'RECT' | 'ELLIPSE' | 'OVAL' | 'NGON' | 'POLYGON';

/** 板上焊盘（绝对坐标，mil） */
export interface BoardPad {
	/** 所属器件图元 ID */
	compId: string;
	designator: string;
	padNumber: string;
	net: string;
	netClass: NetClass;
	x: number;
	y: number;
	/** 外形尺寸（未旋转外接盒，mil）；旋转过的焊盘取外接盒近似 */
	sizeX: number;
	sizeY: number;
	shape: PadShapeKind;
	/** 1=顶层 2=底层 */
	layer: number;
	/** getState_Layer 原始值：1=顶 2=底 12=多层（真直插焊盘必为 12；读不到为 undefined） */
	rawLayer?: number;
	/** 所属器件焊盘总数（BGA 过滤用） */
	pinCount: number;
	/** 直插（金属化孔）焊盘：本身已贯通所有层，无需打孔 */
	hasHole?: boolean;
	/** 孔径（或槽长）最大值 mil；hasHole 时 > 0，用于直插真伪甄别 */
	holeExtentMil?: number;
	/** 阻焊层单边扩展（mil，按焊盘所在层取 top/bottom；读不到为 0） */
	maskExpansionMil?: number;
}

/** 板上已有过孔 */
export interface BoardVia {
	net: string;
	x: number;
	y: number;
	/** 外径 */
	diameter: number;
}

/** 板上已有铜层导线（线段近似） */
export interface BoardTrack {
	net: string;
	layer: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	width: number;
}

export interface BoardOutline {
	/** 板框多边形（凸包，mil） */
	points: Point[];
	bbox: BBox;
}

export interface BoardState {
	outline: BoardOutline;
	pads: BoardPad[];
	vias: BoardVia[];
	tracks: BoardTrack[];
}

/* ------------------------- 插件配置 ------------------------- */

export interface FanoutConfig {
	/** 追加的自定义网络（逗号分隔，支持 GND/3V3/+5V/VBUS 等，忽略大小写） */
	netPatterns: string;
	/** 是否叠加内置电源/地识别规则 */
	useBuiltinPatterns: boolean;
	/** 包含电源网络（VCC/3V3/+5V…） */
	includePower: boolean;
	/** 包含地网络（GND/AGND…） */
	includeGround: boolean;
	/** 过孔孔径 mm */
	viaHoleMm: number;
	/** 过孔外径 mm */
	viaDiameterMm: number;
	/**
	 * 回退小过孔孔径 mm：主过孔 8 方向全阻塞时自动换小一号重试
	 * （0402 等小封装密集区常塞不下 0.6mm 过孔）。设 0 关闭。
	 */
	fallbackViaHoleMm: number;
	/** 回退小过孔外径 mm；<= 主过孔外径且 > 0 时启用回退 */
	fallbackViaDiameterMm: number;
	/**
	 * 额外伸出余量 mm：焊盘边界（阻焊层或焊盘铜皮边缘）-> 过孔边缘。
	 * 0 = 间距规则内就近贴合（默认，过孔边缘贴阻焊开窗边缘）
	 */
	stubMm: number;
	/** 用阻焊层开窗判定焊盘边界（读不到阻焊扩展时退化为焊盘铜皮尺寸） */
	useSolderMask: boolean;
	/**
	 * 盘中孔：过孔直接打在焊盘中心（无连线）。
	 * 过孔整圆须落在焊盘内（外径 <= 焊盘短边），放不下或被占时自动回退就近打孔。
	 * 建议配合树脂塞孔/电镀填孔工艺使用。
	 */
	viaInPad: boolean;
	/** 焊盘-过孔连线宽度 mm；<=0 表示自动（min(焊盘尺寸, 过孔外径)）；实际值恒不超过焊盘尺寸 */
	traceWidthMm: number;
	/** 忽略焊盘数超过该值的器件（保护 BGA，如 LQFP48 设 64） */
	maxPins: number;
	/** 跳过直插（金属化孔）焊盘：本身已贯通所有层；关闭后全部参与打孔（孔数据误判时用） */
	skipThiPads: boolean;
	/** 局部间距预检查安全间距 mm（近似 DRC clearance） */
	clearanceMm: number;
	/** 搜索阻塞时沿方向外扩的最大步数（每步 = 一个过孔外径） */
	maxSearchSteps: number;
	/** 同网络已有过孔在（理想距离 + N 个过孔外径）内则不重复打孔 */
	mergeFactor: number;
	/** 创建后运行真实 DRC 校验，新增违规自动回滚 */
	useDrcCheck: boolean;
	/**
	 * 宽松模式：板子本身可能已有 DRC 违规时使用——
	 * 忽略间距预检查（仅保留 ~2mil 防完全重叠）、跳过连线通道检查，
	 * 并自动跳过 DRC 后校验。可能引入新的 DRC 违规，自负其责。
	 */
	relaxedMode: boolean;
}

export const DEFAULT_CONFIG: FanoutConfig = {
	netPatterns: '',
	useBuiltinPatterns: true,
	includePower: true,
	includeGround: true,
	viaHoleMm: 0.3,
	viaDiameterMm: 0.6,
	fallbackViaHoleMm: 0.2,
	fallbackViaDiameterMm: 0.4,
	stubMm: 0,
	useSolderMask: true,
	viaInPad: false,
	traceWidthMm: 0.4,
	maxPins: 32,
	skipThiPads: true,
	clearanceMm: 0.15,
	maxSearchSteps: 3,
	mergeFactor: 1,
	useDrcCheck: true,
	relaxedMode: false,
};

/* ------------------------- 扇出计划 ------------------------- */

export interface PlannedVia {
	net: string;
	x: number;
	y: number;
	holeDiameter: number;
	diameter: number;
}

export interface PlannedTrack {
	net: string;
	layer: number;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	width: number;
}

export interface PlanItem {
	pad: {
		designator: string;
		padNumber: string;
		net: string;
		netClass: NetClass;
		x: number;
		y: number;
		layer: number;
		sizeX: number;
		sizeY: number;
	};
	via: PlannedVia;
	/** 焊盘-过孔连线；盘中孔（过孔与焊盘同中心）时无连线 */
	track?: PlannedTrack;
	/** 选中方向（度，0=+X 逆时针；盘中孔无方向） */
	directionDeg: number;
	/** 焊盘中心到过孔中心距离 mil */
	distanceMil: number;
	/** 外扩步数（0=理想伸出距离） */
	searchStep: number;
	/** 用了回退小过孔（主过孔放不下时） */
	usedFallback?: boolean;
	/** 盘中孔：过孔直接打在焊盘中心 */
	viaInPad?: boolean;
}

export interface PlanSkip {
	designator: string;
	padNumber: string;
	net: string;
	reason: 'too-many-pins' | 'tht-pad' | 'merged-with-existing-via' | 'blocked';
	detail?: string;
}

export interface FanoutPlan {
	items: PlanItem[];
	skips: PlanSkip[];
	/** 被整体忽略的器件（超 pin 数阈值） */
	ignoredComps: Array<{ designator: string; pinCount: number }>;
	/** 疑似直插误判（脏孔数据，按贴片处理）的焊盘清单，形如 "C114-1" */
	thtSuspects: string[];
	stats: {
		totalPads: number;
		eligiblePads: number;
		planned: number;
		/** 直插焊盘跳过数（真直插） */
		tht: number;
		/** 疑似脏孔、按贴片处理的焊盘数 */
		thtSuspect: number;
		merged: number;
		blocked: number;
		/** 盘中孔（焊盘中心直放）数 */
		viaInPad: number;
	};
}

export function bboxOfPoints(points: Point[]): BBox {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const p of points) {
		if (p.x < minX)
			minX = p.x;
		if (p.y < minY)
			minY = p.y;
		if (p.x > maxX)
			maxX = p.x;
		if (p.y > maxY)
			maxY = p.y;
	}
	return { minX, minY, maxX, maxY };
}

/** mm 配置 -> mil 算法参数（planner 使用） */
export interface FanoutRules {
	viaHole: number;
	viaRadius: number;
	/** 回退小过孔（0 或 >= 主过孔外径时视为禁用） */
	fallbackViaHole: number;
	fallbackViaRadius: number;
	stub: number;
	/** 是否用阻焊层开窗边界作为焊盘边界（就近判定） */
	useMask: boolean;
	/** 盘中孔：过孔直接打在焊盘中心（无连线） */
	viaInPad: boolean;
	traceWidth: number;
	clearance: number;
	/** 宽松模式：预检查间距降为防重叠最小值，连线通道检查跳过 */
	relaxed: boolean;
	maxPins: number;
	skipTht: boolean;
	maxSearchSteps: number;
	mergeFactor: number;
}

/** 宽松模式下的防完全重叠最小间距（mil） */
export const RELAXED_CLEARANCE_MIL = 2;

/** 直插孔最小焊环（mil）：孔径 + 该值必须 <= 焊盘长边，否则塞不进焊环，视为脏孔数据 */
export const THT_MIN_RING_MIL = 0.3 * MM_TO_MIL;

export function configToRules(cfg: FanoutConfig): FanoutRules {
	const mainR = (cfg.viaDiameterMm * MM_TO_MIL) / 2;
	const fbR = (cfg.fallbackViaDiameterMm * MM_TO_MIL) / 2;
	const fbEnabled = fbR > 0 && fbR < mainR;
	return {
		viaHole: cfg.viaHoleMm * MM_TO_MIL,
		viaRadius: mainR,
		fallbackViaHole: fbEnabled ? cfg.fallbackViaHoleMm * MM_TO_MIL : 0,
		fallbackViaRadius: fbEnabled ? fbR : 0,
		stub: cfg.stubMm * MM_TO_MIL,
		useMask: cfg.useSolderMask,
		viaInPad: cfg.viaInPad,
		traceWidth: cfg.traceWidthMm * MM_TO_MIL,
		clearance: cfg.relaxedMode ? RELAXED_CLEARANCE_MIL : cfg.clearanceMm * MM_TO_MIL,
		relaxed: cfg.relaxedMode,
		maxPins: cfg.maxPins,
		skipTht: cfg.skipThiPads,
		maxSearchSteps: cfg.maxSearchSteps,
		mergeFactor: cfg.mergeFactor,
	};
}
