const fs = require('node:fs');
const process = require('node:process');
const JSZip = require('jszip');

const pkg = process.argv[2] || 'build/dist/ai-pcb-autofanout_v0.6.1.eext';
JSZip.loadAsync(fs.readFileSync(pkg)).then(async (z) => {
	const names = Object.keys(z.files).filter(n => !z.files[n].dir);
	console.log('包内文件:');
	names.forEach(n => console.log(' -', n));
	if (!names.includes('iframe/settings.html'))
		throw new Error('缺少 iframe/settings.html（设置面板）');
	const cfg = JSON.parse(await z.file('extension.json').async('string'));
	console.log('版本:', cfg.version, '| 菜单函数:', cfg.headerMenus.pcb[0].menuItems.map(m => m.registerFn).join(', '));
	const src = await z.file('dist/index.js').async('string');
	console.log('bundle 大小:', src.length, '字节');
	// esbuild 默认 ascii charset：中文字符串会被转成 \uXXXX 转义（大写十六进制），两种形式都匹配
	const esc = s => Array.from(s).map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join('');
	const hasStr = s => src.includes(s) || src.includes(esc(s));
	for (const k of ['planFanout', 'classifyNet', 'applyPlan', 'pcb_PrimitiveVia', 'pcb_Drc', 'sys_Dialog', 'openSettingsPanel', 'runFanout', 'hasHole', 'topSolderMask', 'fallbackViaRadius', 'usedFallback', 'relaxedMode', 'skipThiPads', 'dumpDiagnostics', 'viaInPad', '盘中孔', '疑似直插误判', 'holeExtentMil', 'rawLayer', 'isRealThroughHolePad'])
		console.log(`  含 ${k}:`, hasStr(k));
	const html = await z.file('iframe/settings.html').async('string');
	for (const k of ['fanoutConfig', 'viaHoleMm', 'useSolderMask', 'stubMm', 'maxPins', 'useDrcCheck', 'fallbackViaDiameterMm', 'relaxedMode', 'skipThiPads', 'viaInPad', '盘中孔', 'btnSave', 'btnDefaults'])
		console.log(`  面板含 ${k}:`, html.includes(k));
});
