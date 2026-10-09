'use strict';

/*
 * ColorWeb (colorrweb) —— 标签页颜色 + 前进/后退历史悬停提示
 * 纯 JavaScript，无构建步骤，直接由 Obsidian 加载。
 *
 * 功能：
 *   1. 标签栏（页面导航栏）按位置循环上色，默认 8 色、50% 透明度；右键标签可单独改色，也可在设置里改。
 *   2. 鼠标悬停在原生“后退/前进”按钮上时，显示这一次要跳转到的文件名（轻量提示，不加多余视觉噪音）。
 */

var obsidian = require('obsidian');

var DEFAULT_PALETTE = [
	'#FF5838',
	'#FCAB28',
	'#DEF720',
	'#52F720',
	'#20F7D7',
	'#2876ED',
	'#6328ED',
	'#E328ED'
];

var PALETTE_LIMIT = 24;

var DEFAULT_SETTINGS = {
	enabled: true,
	transparentStrip: true,
	historyHint: true,
	opacity: 50, // 0-100：默认 50% 不透明度
	palette: DEFAULT_PALETTE.slice(),
	// 按位置覆盖（第 1 个标签 = 键 "1"）
	positions: {},
	// 按文件路径覆盖（右键某个标签后固定在该文件上）
	overrides: {}
};

function defaultSettings() {
	return {
		enabled: DEFAULT_SETTINGS.enabled,
		transparentStrip: DEFAULT_SETTINGS.transparentStrip,
		historyHint: DEFAULT_SETTINGS.historyHint,
		opacity: DEFAULT_SETTINGS.opacity,
		palette: DEFAULT_PALETTE.slice(),
		positions: {},
		overrides: {}
	};
}

function clampOpacity(v) {
	var n = Number(v);
	if (isNaN(n)) return DEFAULT_SETTINGS.opacity;
	if (n < 0) n = 0;
	if (n > 100) n = 100;
	return Math.round(n);
}

function normalizeHex(value) {
	var v = String(value == null ? '' : value).trim();
	if (!v) return null;
	if (v.charAt(0) !== '#') v = '#' + v;
	if (/^#[0-9a-fA-F]{3}$/.test(v)) {
		v = '#' + v.charAt(1) + v.charAt(1) + v.charAt(2) + v.charAt(2) + v.charAt(3) + v.charAt(3);
	}
	return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null;
}

function hexToRgba(hex, opacity) {
	var h = normalizeHex(hex) || '#000000';
	var r = parseInt(h.slice(1, 3), 16);
	var g = parseInt(h.slice(3, 5), 16);
	var b = parseInt(h.slice(5, 7), 16);
	var a = clampOpacity(opacity) / 100;
	return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
}

function basenameOf(path) {
	if (!path) return '';
	var s = String(path);
	var i = s.lastIndexOf('/');
	var name = i >= 0 ? s.slice(i + 1) : s;
	return name.replace(/\.md$/i, '');
}

/* --------------------------- 小工具 --------------------------- */

function isTabHeader(el) {
	return !!(el && el.nodeType === 1 && typeof el.closest === 'function' &&
		el.closest('.workspace-tab-header'));
}

function getLeafEl(tabEl) {
	var p = tabEl.parentElement;
	while (p) {
		if (p.classList && p.classList.contains('workspace-leaf')) return p;
		p = p.parentElement;
	}
	return null;
}

function tabIndexInStrip(tabEl) {
	var strip = tabEl.parentElement;
	if (!strip) return -1;
	var kids = strip.children;
	for (var i = 0, n = 0; i < kids.length; i++) {
		var k = kids[i];
		if (!k.classList || !k.classList.contains('workspace-tab-header')) continue;
		if (k === tabEl) return n;
		n++;
	}
	return -1;
}

var ColorWebPlugin = class extends obsidian.Plugin {

	async onload() {
		// 注意：本方法里的事件回调都引用 self，忘了这一行会让所有回调抛
		// "self.xxx is not a function"，插件看起来加载成功却什么都不做（1.0.3 的真实事故）。
		var self = this;
		var data = null;
		try {
			data = await this.loadData();
		} catch (e) {
			data = null;
		}
		// 兜底：Obsidian 的 loadData 是直接 JSON.parse 文件内容，
		// 如果 data.json 被别的工具（例如 PowerShell 的 Set-Content -Encoding UTF8）写入 UTF-8 BOM，
		// 它会解析失败并返回 null（控制台会有 "failed to read JSON ... Unexpected token"）。
		// 这里自己再读一次原始文本，剥掉 BOM 后解析，保证设置不会因为 BOM 丢失。
		if (!data) {
			data = await this.readDataIgnoringBom();
		}
		this.settings = Object.assign(defaultSettings(), data || {});
		this.settings.opacity = clampOpacity(this.settings.opacity);
		if (!Array.isArray(this.settings.palette) || !this.settings.palette.length) {
			this.settings.palette = DEFAULT_PALETTE.slice();
		}
		if (!this.settings.positions || typeof this.settings.positions !== 'object') this.settings.positions = {};
		if (!this.settings.overrides || typeof this.settings.overrides !== 'object') this.settings.overrides = {};

		this.observer = null;
		this.observerArmed = false;
		this.tooltipEl = null;
		this.tooltipButton = null;
		this.historyUnpatches = [];
		this._tabEl = null;
		this._lastLog = '';

		this.initColorMenu();
		this.initHistoryPatch();

		this.addSettingTab(new ColorWebSettingTab(this.app, this));

		this.registerDomEvent(window, 'focus', function () { self.refreshColors(); });
		this.registerDomEvent(document, 'mousemove', function (evt) {
			var t = evt.target;
			// Obsidian 原生的提示（比如“后退/前进”）出现时，让位给它
			if (self.nativeTooltipShown()) { self.hideHistoryTooltip(); return; }
			if (t && t.closest && t.closest('.view-header-nav-buttons')) {
				self.updateHistoryTooltip(t);
			} else if (self.tooltipEl) {
				self.hideHistoryTooltip();
			}
		});

		this.registerEvent(this.app.workspace.on('layout-change', function () {
			self.scheduleColorRefresh();
			self.patchAllLeaves();
		}));
		this.registerEvent(this.app.workspace.on('file-open', function () {
			self.scheduleColorRefresh();
			self.scheduleHistoryTooltip();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', function () {
			self.scheduleColorRefresh();
			self.scheduleHistoryTooltip();
		}));
		this.registerEvent(this.app.workspace.on('resize', function () {
			self.scheduleColorRefresh();
			self.scheduleHistoryTooltip();
		}));

		// 监听标签增删（只监听 childList，避免自身写 style 造成循环）
		if (typeof MutationObserver !== 'undefined' && document.body) {
			this.observer = new MutationObserver(function () { self.scheduleColorRefresh(); });
			this.observer.observe(document.body, { childList: true, subtree: true });
		}

		this.applyStripTransparency();
		this.refreshColors();
		// 启动瞬间工作区可能还没完全就绪（标签还没建出来），隔几秒再补几次，确保一定能上色
		[300, 1000, 2500].forEach(function (ms) {
			window.setTimeout(function () {
				try { self.refreshColors(); } catch (e) { self.logError('延时补刷', e); }
			}, ms);
		});
		if (document.readyState !== 'complete') {
			this.registerDomEvent(window, 'load', function () { self.refreshColors(); });
		}
	}

	onunload() {
		if (this.observer) { this.observer.disconnect(); this.observer = null; }
		if (this._colorTimer) { window.clearTimeout(this._colorTimer); this._colorTimer = null; }
		if (this._tipTimer) { window.clearTimeout(this._tipTimer); this._tipTimer = null; }
		this.hideHistoryTooltip();
		this.historyUnpatches.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略 */ } });
		this.historyUnpatches = [];

		try {
			// 直接清 DOM 里所有标签（标签不在 leaf 内部，只遍历 leaf 是清不掉的）
			var allTabs = document.querySelectorAll('.workspace-tab-header');
			for (var t = 0; t < allTabs.length; t++) this.clearTabStyle(allTabs[t]);
		} catch (e) { /* 忽略 */ }
		var strips = document.querySelectorAll('.workspace-tab-header-container');
		for (var i = 0; i < strips.length; i++) strips[i].style.removeProperty('background-color');
	}

	save() {
		try {
			var r = this.saveData(this.settings);
			if (r && typeof r.catch === 'function') r.catch(function () {});
		} catch (e) { /* 忽略保存失败 */ }
	}

	/**
	 * 自己读 data.json 并剥掉 UTF-8 BOM（\uFEFF）后再解析。
	 * 只作为 this.loadData() 失败时的兜底，不改变正常路径。
	 */
	async readDataIgnoringBom() {
		try {
			var dir = this.manifest.dir;
			if (!dir) return null;
			var adapter = this.app.vault.adapter;
			var raw = await adapter.read(dir + '/data.json');
			if (typeof raw !== 'string') return null;
			if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
			try {
				return JSON.parse(raw);
			} catch (e) {
				console.log('[ColorWeb] data.json 解析失败（可能仍是 BOM 或格式损坏），本次使用默认设置：', e.message);
				return null;
			}
		} catch (e) {
			return null;
		}
	}

	/**
	 * 自检日志：每次重新加载插件都会往开发者控制台打一行 [ColorWeb]，
	 * 里面直接给出“有几个标签、第一个标签最终算出来的背景色”，
	 * 方便一眼判断问题出在“插件没跑”“选择器没匹配”还是“被主题/别的插件盖住”。
	 */
	logDiag(sample) {
		try {
			var tabs = document.querySelectorAll('.workspace-tab-header');
			var count = tabs.length;
			var first = tabs[0] || null;
			var written = first ? (first.style.getPropertyValue('--colorweb-tab-bg') || '(未写入)') : '(无标签)';
			var effective = first ? window.getComputedStyle(first).backgroundColor : '(无标签)';
			var msg = '[ColorWeb] v' + ((this.manifest && this.manifest.version) || '?') +
				' 标签数=' + count +
				' 已写入色=' + written +
				' 实际渲染色=' + effective +
				(sample ? (' ' + sample) : '');
			if (msg !== this._lastLog) {
				this._lastLog = msg;
				console.log(msg);
			}
		} catch (e) { /* 忽略 */ }
	}

	/** 出错时明确报出来（不要静默吞掉，否则只会表现为"没颜色"） */
	logError(where, e) {
		try {
			console.error('[ColorWeb] ' + where + ' 出错：', e && e.message, e && e.stack);
		} catch (e2) { /* 忽略 */ }
	}

	colorForIndex(idx) {
		var palette = this.settings.palette;
		if (!palette || !palette.length) return null;
		return normalizeHex(palette[idx % palette.length]);
	}

	/**
	 * 手动指定颜色的键：位置 + 文件都记下来，
	 * 这样“某个标签的某篇文章”是唯一确定的一个标签。
	 */
	overrideKeysFor(index, path) {
		var keys = [];
		if (path) keys.push(path + '#' + index);
		if (path) keys.push(path);
		if (index >= 0) keys.push('#' + index);
		return keys;
	}

	manualColorFor(index, path) {
		var keys = this.overrideKeysFor(index, path);
		for (var i = 0; i < keys.length; i++) {
			var v = this.settings.overrides[keys[i]];
			if (v) {
				var h = normalizeHex(v);
				if (h) return h;
			}
		}
		return null;
	}

	colorForTab(tabEl, index, path) {
		var manual = this.manualColorFor(index, path);
		if (manual) return manual;
		var pos = this.settings.positions[String(index + 1)];
		if (pos) {
			var p = normalizeHex(pos);
			if (p) return p;
		}
		return this.colorForIndex(index);
	}

	clearTabStyle(tabEl) {
		tabEl.style.removeProperty('--colorweb-tab-bg');
		tabEl.style.removeProperty('--colorweb-index');
		tabEl.style.removeProperty('--tab-background-active');
		tabEl.style.removeProperty('background-color');
		delete tabEl.dataset.colorwebKey;
	}

	/**
	 * 把颜色写到标签本身（每次都要覆盖处理）。
	 * 三处一起写，保证任何主题/状态（含“当前激活标签”那条更具体的内置规则）都盖得住：
	 *   1. background-color（带 !important，内联样式优先级最高）
	 *   2. --colorweb-tab-bg（给 styles.css 的规则兜底）
	 *   3. --tab-background-active（Obsidian 激活标签的底色变量，含 ::before/::after 圆角块）
	 * key 用最终写入的 rgba，透明度变化时也能自动刷新。
	 */
	applyTabStyle(tabEl, index, path) {
		var color = this.colorForTab(tabEl, index, path);
		var key = color ? hexToRgba(color, this.settings.opacity) : '';
		if (tabEl.dataset.colorwebKey === key) return;
		tabEl.dataset.colorwebKey = key;
		if (!key) {
			this.clearTabStyle(tabEl);
			return;
		}
		tabEl.style.setProperty('--colorweb-tab-bg', key);
		tabEl.style.setProperty('--tab-background-active', key);
		tabEl.style.setProperty('background-color', key, 'important');
		tabEl.style.setProperty('--colorweb-index', String(index));
	}

	scheduleColorRefresh() {
		var self = this;
		if (this._colorTimer) return;
		this._colorTimer = window.setTimeout(function () {
			self._colorTimer = null;
			self.refreshColors();
		}, 120);
	}

	/**
	 * 收集所有标签元素（正确做法）。
	 *
	 * 关键结构（Obsidian 1.13 源码 createDiv 顺序已确认）：
	 *   .workspace-tabs
	 *     ├ .workspace-tab-header-container   ← 标签在这里
	 *     │   ├ .workspace-tab-header …        （= leaf.tabHeaderEl）
	 *     │   └ -spacer / -new-tab / -tab-list
	 *     └ .workspace-tab-container
	 *         └ .workspace-leaf                ← 笔记本体，和标签是**兄弟**
	 *
	 * 所以不能对 leaf.containerEl 用 querySelector('.workspace-tab-header-container')
	 * ——那是找"后代"，永远找不到（1.0.0~1.0.4 的致命错，26 个标签一个都没上色）。
	 */
	collectTabEntries() {
		var self = this;
		var entries = [];
		var claimed = new Set();
		try {
			this.app.workspace.iterateAllLeaves(function (leaf) {
				var el = leaf.containerEl;
				var tabEl = leaf.tabHeaderEl;
				if (!tabEl) {
					// 兜底：假设标签栏真在 leaf 内部
					var strip = el ? el.querySelector('.workspace-tab-header-container') : null;
					if (!strip) return;
					var kids = strip.children;
					for (var i = 0; i < kids.length; i++) {
						var k = kids[i];
						if (k.classList && k.classList.contains('workspace-tab-header')) {
							entries.push({ tab: k, path: null, src: 'strip' });
						}
					}
					if (strip.parentElement) claimed.add(strip.parentElement);
					return;
				}
				if (tabEl.parentElement) claimed.add(tabEl.parentElement);
				entries.push({ tab: tabEl, path: self.pathOfTab(tabEl), src: 'leaf' });
			});
		} catch (e) { /* 忽略 */ }
		var anyDom = false;
		var all = document.querySelectorAll('.workspace-tab-header');
		for (var i = 0; i < all.length; i++) {
			var t = all[i];
			var known = false;
			for (var j = 0; j < entries.length; j++) { if (entries[j].tab === t) { known = true; break; } }
			if (known) continue;
			var parent = t.parentElement;
			// 只处理没人认领的标签栏（例如某个没进 iterateAllLeaves 的视图）
			if (parent && !claimed.has(parent)) {
				anyDom = true;
				entries.push({ tab: t, path: self.pathOfTab(t), src: 'dom' });
			}
		}
		return { entries: entries, src: (anyDom ? 'leaf+dom' : 'leaf') };
	}

	/** 同一条标签栏内按顺序编号 0,1,2…（颜色循环用） */
	indexInStrip(tabEl) {
		var strip = tabEl.parentElement;
		if (!strip) return 0;
		var kids = strip.children;
		for (var i = 0, n = 0; i < kids.length; i++) {
			var k = kids[i];
			if (!k.classList || !k.classList.contains('workspace-tab-header')) continue;
			if (k === tabEl) return n;
			n++;
		}
		return 0;
	}

	refreshColors() {
		var self = this;
		if (!this.settings) return;
		var trace = [];
		try {
			this.applyStripTransparency();
			if (!this.observerArmed) {
				this.observerArmed = true;
				window.setTimeout(function () { self.observerArmed = false; }, 250);
			}
			if (!this.settings.enabled) {
				// 关掉颜色时也要把已写入的样式清掉
				var off = document.querySelectorAll('.workspace-tab-header');
				for (var o = 0; o < off.length; o++) this.clearTabStyle(off[o]);
				trace.push('已禁用');
				this.logDiag(trace.join(' '));
				return;
			}
			var found = this.collectTabEntries();
			var entries = found.entries;
			var applied = 0;
			for (var i = 0; i < entries.length; i++) {
				try {
					this.applyTabStyle(entries[i].tab, this.indexInStrip(entries[i].tab), entries[i].path);
					applied++;
				} catch (e) {
					trace.push('第' + (i + 1) + '个失败:' + (e && e.message));
				}
			}
			trace.push('来源=' + found.src + ' 已上色=' + applied + '/' + entries.length);
			this.logDiag(trace.join(' '));
		} catch (e) {
			// 以前这里是空 catch，导致"抛异常"和"没颜色"长得一模一样（1.0.4 修）
			this.logError('refreshColors', e);
		}
	}

	pathOfTab(tabEl) {
		var leaf = this.leafOfTab(tabEl);
		if (!leaf) return null;
		var view = leaf.view;
		if (!view) return null;
		if (view.file && view.file.path) return view.file.path;
		// 多标签页栈里容器可能被嵌套，只有 tabHeaderEl 完全对得上时才算数
		if (tabEl && leaf.tabHeaderEl && leaf.tabHeaderEl !== tabEl) return null;
		if (typeof view.getState === 'function') {
			try {
				var st = view.getState();
				if (st && st.file) return st.file;
			} catch (e) { /* 忽略 */ }
		}
		return null;
	}

	leafOfTab(tabEl) {
		var leafEl = getLeafEl(tabEl);
		if (!leafEl) return null;
		var found = null;
		try {
			this.app.workspace.iterateAllLeaves(function (leaf) {
				if (!found && leaf.containerEl === leafEl) found = leaf;
			});
		} catch (e) { /* 忽略 */ }
		return found;
	}

	applyStripTransparency() {
		var on = !!(this.settings && this.settings.enabled && this.settings.transparentStrip);
		var strips = document.querySelectorAll('.workspace-tab-header-container');
		for (var i = 0; i < strips.length; i++) {
			if (on) strips[i].style.backgroundColor = 'transparent';
			else strips[i].style.removeProperty('background-color');
		}
	}

	/* ------------------------ 右键菜单：改标签颜色 ------------------------ */

	initColorMenu() {
		var self = this;
		this.registerDomEvent(document, 'contextmenu', function (evt) { self.captureTab(evt); }, true);
		this.registerEvent(this.app.workspace.on('file-menu', function (menu, file) {
			try { self.addTabColorMenu(menu, file); } catch (e) { /* 忽略 */ }
		}));
	}

	captureTab(evt) {
		var el = evt.target;
		if (!isTabHeader(el)) { this._tabEl = null; return; }
		this._tabEl = el;
		this._ignoreMenu = !!(document.body && document.body.classList.contains('is-grabbing'));
	}

	addTabColorMenu(menu, file) {
		var tabEl = this._tabEl;
		var idx = -1;
		if (tabEl && !this._ignoreMenu) idx = tabIndexInStrip(tabEl);
		var path = (file && file.path) || (tabEl ? this.pathOfTab(tabEl) : null) || null;
		var overrideKey = path && idx >= 0 ? (path + '#' + idx) : null;
		var label = (file && file.basename) || basenameOf(path);
		var self = this;
		var current = this.manualColorFor(idx, path);
		if (!current && idx >= 0) current = normalizeHex(this.settings.positions[String(idx + 1)]);
		if (!current && idx >= 0) current = this.colorForIndex(idx);

		menu.addItem(function (item) {
			item.setTitle(label ? ('标签颜色：' + label) : '标签颜色');
			item.setIcon('palette');
			var sub = item.setSubmenu();

			self.settings.palette.slice(0, PALETTE_LIMIT).forEach(function (hex, i) {
				var h = normalizeHex(hex);
				if (!h) return;
				sub.addItem(function (it) {
					it.setTitle('颜色 ' + (i + 1) + '　' + h);
					var dot = document.createElement('span');
					dot.className = 'colorweb-dot';
					dot.style.backgroundColor = h;
					if (it.dom && it.dom.prepend) it.dom.prepend(dot);
					if (current && current === h) it.setChecked(true);
					it.onClick(function () {
						if (overrideKey) self.settings.overrides[overrideKey] = h;
						if (idx >= 0) self.settings.positions[String(idx + 1)] = h;
						self.save();
						self.refreshColors();
					});
				});
			});

			sub.addSeparator();
			sub.addItem(function (it) {
				it.setTitle('恢复默认（按顺序自动配色）');
				it.setIcon('rotate-ccw');
				it.onClick(function () {
					if (overrideKey) delete self.settings.overrides[overrideKey];
					if (idx >= 0) delete self.settings.positions[String(idx + 1)];
					self.save();
					self.refreshColors();
				});
			});
		});
	}

	/* ------------------- 前进 / 后退按钮的悬停提示 ------------------- */

	initHistoryPatch() {
		this.patchAllLeaves();
	}

	patchAllLeaves() {
		var self = this;
		try {
			this.app.workspace.iterateAllLeaves(function (leaf) { self.patchLeafHistory(leaf); });
		} catch (e) { /* 忽略 */ }
	}

	patchLeafHistory(leaf) {
		var self = this;
		if (!leaf || !leaf.history || leaf.history.__colorwebPatched) return;
		var history = leaf.history;
		if (typeof history.go !== 'function') return;
		var original = history.go;
		history.__colorwebOriginalGo = original;
		history.go = function () {
			var result = original.apply(this, arguments);
			try {
				window.setTimeout(function () { self.scheduleHistoryTooltip(); }, 80);
			} catch (e) { /* 忽略 */ }
			return result;
		};
		history.__colorwebPatched = true;
		this.historyUnpatches.push(function () {
			if (history.__colorwebOriginalGo) {
				history.go = history.__colorwebOriginalGo;
				delete history.__colorwebOriginalGo;
			}
			delete history.__colorwebPatched;
		});
	}

	scheduleHistoryTooltip() {
		var self = this;
		if (this._tipTimer) window.clearTimeout(this._tipTimer);
		this._tipTimer = window.setTimeout(function () {
			self._tipTimer = null;
			if (self.tooltipButton) self.updateHistoryTooltip(self.tooltipButton);
		}, 120);
	}

	navButtons() {
		var active = this.app.workspace.activeLeaf;
		if (!active || !active.containerEl) return null;
		var wrap = active.containerEl.querySelector('.view-header-nav-buttons');
		if (!wrap) return null;
		var buttons = wrap.querySelectorAll('button');
		return { leaf: active, back: buttons[0] || null, forward: buttons[1] || null };
	}

	historyTarget(button) {
		var info = this.navButtons();
		if (!info || !info.leaf || !info.leaf.history) return null;
		var history = info.leaf.history;
		var arr = null;
		if (button === info.back) arr = history.backHistory;
		else if (button === info.forward) arr = history.forwardHistory;
		else return null;
		if (!arr || !arr.length) return null;
		return arr[arr.length - 1] || null;
	}

	updateHistoryTooltip(target) {
		var button = target && target.closest ? target.closest('button') : null;
		if (!button) { this.hideHistoryTooltip(); return; }
		this.tooltipButton = button;
		if (!this.settings || !this.settings.historyHint) { this.hideHistoryTooltip(); return; }
		var item = this.historyTarget(button);
		var title = item ? (item.title || basenameOf(item.path || '')) : '';
		if (!title) { this.hideHistoryTooltip(); return; }
		this.showHistoryTooltip(button, title);
	}

	showHistoryTooltip(button, text) {
		var el = this.tooltipEl;
		if (!el) {
			el = document.body.createDiv({ cls: 'colorweb-tooltip' });
			this.tooltipEl = el;
		}
		if (el.textContent !== text) el.setText(text);
		if (el.style.display === 'none') el.show();
		var r = button.getBoundingClientRect();
		var w = el.offsetWidth || 0;
		var h = el.offsetHeight || 0;
		// 放在按钮右侧，避开 Obsidian 自己的提示（它出现在按钮下方）
		var left = r.right + 8;
		if (left + w > window.innerWidth - 6) left = Math.max(6, r.left - w - 8);
		var top = r.top + (r.height - h) / 2;
		var maxTop = window.innerHeight - h - 6;
		if (top > maxTop) top = Math.max(6, maxTop);
		if (top < 6) top = 6;
		// 用 fixed 定位，避免被滚动容器/层叠上下文影响
		el.style.position = 'fixed';
		el.style.left = left + 'px';
		el.style.top = top + 'px';
	}

	/** Obsidian 原生 tooltip 是否正在显示（显示时我们让位，避免两个提示叠在一起） */
	nativeTooltipShown() {
		var els = document.querySelectorAll('.tooltip');
		if (!els || !els.length) return false;
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (el.style.display === 'none') continue;
			try {
				if (window.getComputedStyle(el).display === 'none') continue;
			} catch (e) { /* 忽略 */ }
			if (el.offsetWidth) return true;
		}
		return false;
	}

	hideHistoryTooltip() {
		if (this.tooltipEl) this.tooltipEl.hide();
		this.tooltipButton = null;
	}
};

/* ------------------------------ 设置界面 ------------------------------ */

var ColorWebSettingTab = class extends obsidian.PluginSettingTab {

	display() {
		var self = this;
		var plugin = this.plugin;
		var container = this.containerEl;
		container.empty();
		container.createEl('h2', { text: 'ColorWeb 设置' });

		new obsidian.Setting(container)
			.setName('启用标签颜色')
			.setDesc('按标签顺序循环使用下面的配色。')
			.addToggle(function (t) {
				t.setValue(plugin.settings.enabled).onChange(function (v) {
					plugin.settings.enabled = v;
					plugin.save();
					plugin.refreshColors();
				});
			});

		new obsidian.Setting(container)
			.setName('标签栏透明')
			.setDesc('让标签之间的底色透出背景（颜色本身已经带透明度）。')
			.addToggle(function (t) {
				t.setValue(plugin.settings.transparentStrip).onChange(function (v) {
					plugin.settings.transparentStrip = v;
					plugin.save();
					plugin.applyStripTransparency();
				});
			});

		new obsidian.Setting(container)
			.setName('不透明度')
			.setDesc('默认 50%；数值越小越能透出背景。')
			.addSlider(function (s) {
				s.setLimits(0, 100, 1).setValue(plugin.settings.opacity).setDynamicTooltip().onChange(function (v) {
					plugin.settings.opacity = clampOpacity(v);
					plugin.save();
					plugin.refreshColors();
				});
			});

		new obsidian.Setting(container)
			.setName('前进 / 后退悬停提示')
			.setDesc('鼠标移到标题栏的前进/后退按钮上时，显示这次将跳转到的文件名。')
			.addToggle(function (t) {
				t.setValue(plugin.settings.historyHint).onChange(function (v) {
					plugin.settings.historyHint = v;
					plugin.save();
					if (!v) plugin.hideHistoryTooltip();
				});
			});

		container.createEl('h3', { text: '循环配色（第 1 ~ N 个标签依次使用）' });
		var grid = container.createDiv({ cls: 'colorweb-grid' });
		plugin.settings.palette.forEach(function (hex, i) {
			var cell = grid.createDiv({ cls: 'colorweb-cell' });
			cell.createDiv({ cls: 'colorweb-cell-label', text: '第 ' + (i + 1) + ' 个' });
			new obsidian.ColorComponent(cell)
				.setValue(normalizeHex(hex) || '#000000')
				.onChange(function (v) {
					var h = normalizeHex(v);
					if (!h) return;
					plugin.settings.palette[i] = h;
					plugin.save();
					plugin.refreshColors();
				});
		});

		container.createEl('h3', { text: '手动指定（按标签位置）' });
		var posKeys = Object.keys(plugin.settings.positions).sort(function (a, b) { return Number(a) - Number(b); });
		if (!posKeys.length) {
			container.createEl('p', { cls: 'setting-item-description', text: '暂无。在标签上点右键 → “标签颜色” 即可指定。' });
		}
		posKeys.forEach(function (k) {
			new obsidian.Setting(container)
				.setName('第 ' + k + ' 个标签')
				.addColorPicker(function (c) {
					c.setValue(normalizeHex(plugin.settings.positions[k]) || '#000000').onChange(function (v) {
						var h = normalizeHex(v);
						if (!h) return;
						plugin.settings.positions[k] = h;
						plugin.save();
						plugin.refreshColors();
					});
				})
				.addExtraButton(function (b) {
					b.setIcon('trash').setTooltip('移除').onClick(function () {
						delete plugin.settings.positions[k];
						plugin.save();
						plugin.refreshColors();
						self.display();
					});
				});
		});

		container.createEl('h3', { text: '手动指定（按文件）' });
		var fileKeys = Object.keys(plugin.settings.overrides);
		if (!fileKeys.length) {
			container.createEl('p', { cls: 'setting-item-description', text: '暂无。在标签上点右键 → “标签颜色” 即可指定。' });
		}
		fileKeys.forEach(function (p) {
			new obsidian.Setting(container)
				.setName(p)
				.addColorPicker(function (c) {
					c.setValue(normalizeHex(plugin.settings.overrides[p]) || '#000000').onChange(function (v) {
						var h = normalizeHex(v);
						if (!h) return;
						plugin.settings.overrides[p] = h;
						plugin.save();
						plugin.refreshColors();
					});
				})
				.addExtraButton(function (b) {
					b.setIcon('trash').setTooltip('移除').onClick(function () {
						delete plugin.settings.overrides[p];
						plugin.save();
						plugin.refreshColors();
						self.display();
					});
				});
		});

		new obsidian.Setting(container)
			.setName('恢复默认配色')
			.setDesc('写回 8 个默认颜色，并清空所有手动指定。')
			.addButton(function (b) {
				b.setButtonText('恢复默认').onClick(function () {
					plugin.settings.palette = DEFAULT_PALETTE.slice();
					plugin.settings.positions = {};
					plugin.settings.overrides = {};
					plugin.settings.opacity = DEFAULT_SETTINGS.opacity;
					plugin.save();
					plugin.refreshColors();
					self.display();
				});
			});
	}
};

module.exports = ColorWebPlugin;
