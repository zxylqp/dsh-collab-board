/**
 * 协作看板 · 客户端半边（手写 bundle，无打包器、无 npm 依赖）
 *
 * DSH 浏览器插件契约（照 feiyu-memory 验证过的三条来，别自己发明）：
 *   1. 必须调 `window.__ModuleLoader__.load({ id, factory })`
 *   2. `id` **必须等于包名** —— 模块身份就是解析出来的包名
 *   3. `factory(require)` 返回 Cordis 插件 `{ name, inject, apply }`
 *
 * 0.2.0：面板从 iframe 换成 React 组件，直接渲染进侧栏。
 * 为什么换：iframe 拿不到宿主的 `--dsw-alias-*` 主题 token，换主题它不变。
 *
 * 三视图（同一个面板内切）：看板 / 设置 / 成员与连接。
 * 这一版**只做界面**：Hub、协议、租约下一轮接。所以界面上凡是需要 Hub 的按钮
 * （认领 / 我来当 Hub / 下载 hub 文件）都是 disabled + 写清原因 —— 不放假开关。
 */
window.__ModuleLoader__.load({
  id: 'dsh-collab-board',

  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback, Fragment } = React;

    /** 侧栏格子 id，同时也是主面板 key。必须与注册处一致。 */
    const PANEL_ID = 'collab-board';
    /** 宿主接口前缀，与 host 半边的 PANEL_BASE 必须对得上。 */
    const API = '/collab-board';
    /** 面板构建号：改一次 client 就 +1，用来判断浏览器是不是还在用旧 bundle。 */
    const BUILD = 31;
    const VERSION = '0.11.14';
    /** 宽到这个值以上才用「左列表 + 右详情」；窄了改成列表 → 点开全屏详情。 */
    const WIDE_AT = 620;

    /** 与宿主 SETTINGS_SPEC 的默认值保持一致（宿主返回的会覆盖它）。 */
    const SETTINGS_DEFAULTS = {
      selfName: '',
      role: 'solo',
      pollIntervalMs: 3000,
      showSystemEvents: true,
      showArtifacts: true,
      autoScroll: true,
      timeFormat: 'clock',
      maxReplay: 500,
      maxEvents: 20000,
      retentionDays: 30,
      showDeleted: false,
      hubAddress: '',
      hubPort: 48910,
      discoveryPort: 48911,
      hubCode: '',
      hubCodeSet: false,
      pendingWatch: false,
      pendingWatchMs: 300000,
      autoClaim: true,
      autoClaimMs: 60000,
      hiddenMembers: '',
      wakeOnMessage: false,
      wakeCooldownMs: 300000,
      wakeRetries: 3,
      wakeSelfContinue: false,
      wakeSelfContinueMax: 8,
    };

    const ROLE_LABEL = { solo: '单机', hub: 'Hub', member: '成员' };
    const ROLE_MODE = { solo: '单机模式', hub: 'Hub 主机', member: '成员模式' };
    const STATUS_LABEL = {
      pending: '待认领',
      running: '进行中',
      blocked: '已阻塞',
      done: '已完成',
      cancelled: '已取消',
    };
    const STATUS_TONE = {
      pending: 'pending',
      running: 'run',
      blocked: 'blocked',
      done: 'done',
      cancelled: 'cancelled',
    };
    const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低' };
    /** 头像底色只用宿主 token，不写死颜色；不同 origin 落到不同 token 上。 */
    const AVATAR_TOKENS = [
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-label-primary-bluish',
      '--dsw-alias-link',
    ];

    /* ────────────────────────────── 样式 ────────────────────────────── */

    const CSS = `
.cb-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:420px;box-sizing:border-box;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  font-family:inherit;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;}
.cb-wrap{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;
  padding:16px 22px 12px;box-sizing:border-box;gap:12px;}
.cb-head{display:flex;align-items:center;gap:10px;flex:none;min-height:32px;}
.cb-head-icon{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;flex:none;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);}
.cb-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cb-title{font-size:17px;font-weight:600;letter-spacing:.2px;line-height:1.3;}
.cb-title-ver{font-size:11px;font-weight:500;letter-spacing:0;color:var(--dsw-alias-label-tertiary);
  margin-left:7px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-overlay);vertical-align:middle;}
.cb-title-ver.cb-drift{color:var(--dsw-alias-label-error);font-weight:600;}
.cb-sub{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-overlay);flex:none;}
.cb-seg-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;line-height:26px;padding:0 11px;border-radius:7px;cursor:pointer;white-space:nowrap;}
.cb-seg-btn:hover{color:var(--dsw-alias-label-primary);}
.cb-seg-btn[data-on]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;
  box-shadow:0 1px 2px var(--dsw-alias-border-l2);}
.cb-banner{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;flex:none;
  font-size:11.5px;line-height:17px;border-left:2px solid var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);
  color:var(--dsw-alias-state-warn-label);}
.cb-banner[data-tone="error"]{border-left-color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);
  color:var(--dsw-alias-label-error);}
.cb-banner[data-tone="info"]{border-left-color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);
  color:var(--dsw-alias-label-secondary);}
.cb-banner-text{flex:1;min-width:0;}
.cb-banner-actions{display:flex;gap:4px;flex:none;}
.cb-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}
.cb-board{flex:1;min-height:0;display:flex;}
.cb-col-list{display:flex;flex-direction:column;min-height:0;width:34%;min-width:300px;max-width:440px;flex:none;}
.cb-col-detail{display:flex;flex-direction:column;min-height:0;flex:1;min-width:0;
  padding-left:14px;border-left:1px solid var(--dsw-alias-border-l1);}
.cb-narrow .cb-col-list{width:100%;max-width:none;}
.cb-narrow .cb-col-detail{display:none;padding-left:0;border-left:0;}
.cb-narrow[data-detail="1"] .cb-col-list{display:none;}
.cb-narrow[data-detail="1"] .cb-col-detail{display:flex;}
.cb-toolbar{display:flex;align-items:center;gap:4px;flex:none;padding-bottom:6px;}
.cb-toolbar-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);flex:none;margin-right:2px;}
.cb-toolbar .cb-grow{flex:1;min-width:0;}
.cb-filter{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;
  font-size:12px;line-height:22px;padding:0 8px;border-radius:999px;cursor:pointer;white-space:nowrap;}
.cb-filter:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}
.cb-filter[data-on]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);font-weight:600;}
.cb-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
  padding:1px 2px 8px;display:flex;flex-direction:column;gap:2px;}
.cb-scroll::-webkit-scrollbar{width:6px;height:6px;}
.cb-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:3px;}
.cb-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);}
.cb-scroll::-webkit-scrollbar-track{background:transparent;}
.cb-task{position:relative;display:flex;flex-direction:column;gap:4px;padding:10px 11px 10px 13px;border-radius:10px;
  cursor:pointer;border:1px solid transparent;transition:background .12s,border-color .12s;box-sizing:border-box;}
.cb-task:hover{background:var(--dsw-alias-interactive-bg-hover);}
.cb-task[data-on]{background:var(--dsw-alias-button-ghost-active-fill);border-color:var(--dsw-alias-border-l1);}
.cb-task::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:2px;border-radius:2px;background:transparent;}
.cb-task[data-on]::before{background:var(--dsw-alias-button-info-fill);}
.cb-task[data-pri="high"]:not([data-on])::before{background:var(--dsw-alias-state-error-primary);}
.cb-task[data-archived]{opacity:.62;}
.cb-row{display:flex;align-items:center;gap:6px;min-width:0;}
.cb-task-title{flex:1;min-width:0;font-size:13.5px;font-weight:500;line-height:1.45;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-task[data-done] .cb-task-title{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;
  text-decoration-color:var(--dsw-alias-border-l4);}
.cb-task[data-pri="low"] .cb-task-title{color:var(--dsw-alias-label-secondary);}
.cb-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;line-height:17px;
  color:var(--dsw-alias-label-tertiary);}
.cb-meta-id{flex:none;font-variant-numeric:tabular-nums;letter-spacing:.2px;}
.cb-meta-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-meta-right{flex:none;display:flex;align-items:center;gap:4px;}
.cb-bar{width:46px;height:3px;border-radius:2px;background:var(--dsw-alias-bg-overlay);overflow:hidden;flex:none;}
.cb-bar i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);border-radius:2px;}
.cb-pill{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px;line-height:18px;padding:0 8px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.cb-pill[data-tone="run"]{color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);}
.cb-pill[data-tone="blocked"]{color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);}
.cb-pill[data-tone="done"]{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent);}
.cb-pill[data-tone="pending"]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-overlay);}
.cb-pill[data-tone="cancelled"]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-fill-l1);}
.cb-pill[data-tone="high"]{color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
.cb-pill[data-tone="low"]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-fill-l1);}
.cb-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary);}
.cb-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary);}
.cb-dot[data-tone="busy"]{background:var(--dsw-alias-state-warn-primary);}
.cb-dot[data-tone="off"]{background:var(--dsw-alias-label-dimmed);}
.cb-dot[data-tone="sync"]{background:var(--dsw-alias-label-caption);}
.cb-pdot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-state-error-primary);}
.cb-avatar{width:26px;height:26px;border-radius:50%;flex:none;display:grid;place-items:center;
  font-size:11px;font-weight:600;color:var(--cb-av);background:color-mix(in srgb,var(--cb-av) 16%,transparent);}
.cb-avatar[data-sm]{width:20px;height:20px;font-size:9.5px;}
.cb-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  padding:26px 14px;text-align:center;color:var(--dsw-alias-label-tertiary);min-height:0;}
.cb-empty-icon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;margin-bottom:2px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-tertiary);}
.cb-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.cb-empty-desc{font-size:12px;line-height:18px;max-width:280px;}
.cb-card{border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  padding:12px 13px;box-sizing:border-box;flex:none;box-shadow:0 1px 2px var(--dsw-alias-border-l1);}
.cb-card-h{display:flex;align-items:center;gap:6px;margin:0 0 2px;font-size:13px;font-weight:600;line-height:1.5;}
.cb-card-h .cb-grow{flex:1;min-width:0;}
.cb-card-sub{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:0;}
.cb-detail{flex:1;min-height:0;display:flex;flex-direction:column;}
.cb-detail-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:1px 2px 10px;}
.cb-detail-top{display:flex;align-items:flex-start;gap:10px;}
.cb-detail-top-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;}
.cb-detail-title{font-size:18px;font-weight:600;line-height:1.35;margin:0;word-break:break-word;}
.cb-detail-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.cb-actions{display:flex;gap:6px;flex:none;align-items:center;}
.cb-btn{appearance:none;font:inherit;font-size:12px;line-height:16px;height:30px;padding:0 12px;border-radius:8px;
  cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;gap:4px;
  white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s;}
.cb-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);}
.cb-btn[data-primary]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;
  color:var(--dsw-alias-label-primary-inverted);font-weight:600;}
.cb-btn[data-primary]:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover);}
.cb-btn[data-ghost]{border-color:transparent;background:transparent;color:var(--dsw-alias-link);}
.cb-btn[data-ghost]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);}
.cb-btn[data-danger]{color:var(--dsw-alias-label-error);}
.cb-btn[data-danger]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger);}
.cb-btn[data-sm]{height:24px;padding:0 8px;font-size:11px;border-radius:7px;}
.cb-btn[disabled]{opacity:.45;cursor:not-allowed;}
.cb-warnline{display:flex;align-items:flex-start;gap:5px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-state-warn-label);}
.cb-errline{display:flex;align-items:flex-start;gap:5px;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-error);}
.cb-hint{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.cb-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:11.5px;line-height:1.6;
  padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1);}
.cb-kv:first-of-type{border-top:0;}
.cb-kv-k{flex:none;color:var(--dsw-alias-label-tertiary);}
.cb-kv-v{min-width:0;text-align:right;font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cb-linkish{appearance:none;border:0;background:transparent;font:inherit;color:var(--dsw-alias-link);
  cursor:pointer;padding:0;text-align:left;}
.cb-linkish:hover{text-decoration:underline;}
.cb-dep{display:flex;align-items:center;gap:5px;font-size:11.5px;line-height:19px;min-width:0;}
.cb-dep[data-bad]{color:var(--dsw-alias-label-error);}
.cb-dep[data-good]{color:var(--dsw-alias-label-secondary);}
.cb-file{display:flex;align-items:center;gap:7px;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:11.5px;min-width:0;}
.cb-file:first-of-type{border-top:0;}
.cb-file-icon{width:22px;height:22px;border-radius:6px;flex:none;display:grid;place-items:center;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-tertiary);}
.cb-file-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cb-file-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-file-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-file[data-dead] .cb-file-name{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;
  text-decoration-color:var(--dsw-alias-border-l4);}
.cb-msg{display:flex;gap:7px;padding:3px 0;min-width:0;}
.cb-msg[data-me]{flex-direction:row-reverse;}
.cb-msg-body{max-width:80%;min-width:0;display:flex;flex-direction:column;gap:2px;}
.cb-msg[data-me] .cb-msg-body{align-items:flex-end;}
.cb-msg-name{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);}
.cb-msg-bubble{font-size:13px;line-height:1.55;padding:7px 10px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay);white-space:pre-wrap;word-break:break-word;}
.cb-msg[data-me] .cb-msg-bubble{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent);}
.cb-sys{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary);text-align:center;
  padding:2px 10px;word-break:break-word;}
.cb-sys em{font-style:normal;color:var(--dsw-alias-label-caption);margin-right:4px;}
.cb-cmt-row{display:flex;align-items:center;gap:6px;font-size:11px;line-height:18px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-overlay);
  border-radius:8px;padding:5px 8px;cursor:pointer;border:0;font-family:inherit;text-align:left;width:100%;}
.cb-cmt-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.cb-cmt-row .cb-grow{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-composer{display:flex;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center;}
.cb-composer .cb-input{flex:1;min-width:0;}
.cb-input{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border-radius:8px;font:inherit;font-size:12px;
  border:1px solid transparent;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  outline:none;transition:background .12s,border-color .12s;}
.cb-input::placeholder{color:var(--dsw-alias-label-tertiary);}
.cb-input:hover:not(:focus){background:var(--dsw-alias-interactive-bg-hover);}
.cb-input:focus{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);}
.cb-input[data-invalid]{border-color:var(--dsw-alias-state-error-primary);}
.cb-textarea{height:auto;min-height:64px;padding:7px 9px;resize:vertical;line-height:1.5;}
.cb-num{width:92px;flex:none;text-align:right;font-variant-numeric:tabular-nums;}
.cb-sw{flex:none;position:relative;width:36px;height:20px;border-radius:999px;border:0;padding:0;cursor:pointer;
  background:var(--dsw-alias-fill-tertiary);transition:background .16s;}
.cb-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);transition:transform .16s;
  box-shadow:0 1px 2px var(--dsw-alias-border-l3);}
.cb-sw[data-on]{background:var(--dsw-alias-button-info-fill);}
.cb-sw[data-on]::after{transform:translateX(16px);}
.cb-sw[disabled]{opacity:.45;cursor:not-allowed;}
.cb-settings{flex:1;min-height:0;display:flex;gap:14px;}
.cb-settings-nav{width:150px;flex:none;display:flex;flex-direction:column;gap:2px;padding-top:2px;}
.cb-navitem{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;text-align:left;padding:7px 9px;border-radius:8px;cursor:pointer;}
.cb-navitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.cb-navitem[data-on]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);font-weight:600;}
.cb-settings-main{flex:1;min-width:0;min-height:0;overflow-y:auto;padding-right:2px;}
.cb-form{display:flex;flex-direction:column;gap:10px;}
.cb-field{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1);}
.cb-field:first-of-type{border-top:0;padding-top:2px;}
.cb-field-label{width:104px;flex:none;font-size:11.5px;line-height:30px;text-align:right;
  color:var(--dsw-alias-label-secondary);}
.cb-field-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.cb-field-row{display:flex;align-items:center;gap:10px;min-width:0;}
.cb-field-row .cb-field-desc{flex:1;min-width:0;}
.cb-field-desc{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.cb-field-ctl{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:none;}
.cb-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.cb-cap{display:inline-flex;align-items:center;gap:4px;font-size:10px;line-height:16px;padding:0 6px;
  border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);}
.cb-cap::before{content:"";width:4px;height:4px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary);}
.cb-cap[data-manual]::before{background:var(--dsw-alias-state-warn-primary);}
.cb-members{flex:1;min-height:0;display:flex;gap:14px;}
.cb-members-list{width:300px;flex:none;display:flex;flex-direction:column;min-height:0;}
.cb-members-detail{flex:1;min-width:0;min-height:0;overflow-y:auto;display:grid;
  grid-template-columns:repeat(auto-fit,minmax(360px,1fr));align-content:start;gap:12px;}
.cb-members-detail>.cb-banner{grid-column:1/-1;}
.cb-narrow .cb-members{flex-direction:column;gap:10px;}
.cb-narrow .cb-members-list{width:auto;flex:none;max-height:210px;}
.cb-narrow .cb-members-detail{overflow-y:auto;}
.cb-member{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;min-width:0;}
.cb-member:hover{background:var(--dsw-alias-interactive-bg-hover);}
.cb-member-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cb-member-name{display:flex;align-items:center;gap:5px;font-size:13px;line-height:18px;min-width:0;}
.cb-member-name span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cb-member-sub{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);}
.cb-narrow .cb-settings{flex-direction:column;gap:8px;}
.cb-narrow .cb-settings-nav{width:auto;flex-direction:row;overflow-x:auto;padding:0 0 2px;}
.cb-narrow .cb-settings-nav .cb-navitem{white-space:nowrap;padding:5px 9px;font-size:11px;}
.cb-narrow .cb-field{flex-direction:column;gap:4px;}
.cb-narrow .cb-field-label{width:auto;text-align:left;line-height:16px;}
.cb-toasts{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;
  display:flex;flex-direction:column;gap:6px;width:min(92%,420px);pointer-events:none;}
.cb-toast{pointer-events:auto;border-radius:9px;padding:7px 11px;font-size:11.5px;line-height:1.5;
  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px var(--dsw-alias-bg-mask-2);}
.cb-toast[data-tone="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);}
.cb-menu{position:fixed;z-index:20;min-width:132px;padding:4px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 8px 24px var(--dsw-alias-bg-mask-2);}
.cb-menu button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:11.5px;line-height:18px;text-align:left;width:100%;padding:5px 8px;border-radius:6px;cursor:pointer;}
.cb-menu button:hover{background:var(--dsw-alias-interactive-bg-hover);}
.cb-menu button[data-danger]{color:var(--dsw-alias-label-error);}
.cb-foot{display:flex;align-items:center;gap:8px;flex:none;padding:2px 0 0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-quaternary);}
.cb-foot .cb-grow{flex:1;}
.cb-skel{height:12px;border-radius:6px;background:var(--dsw-alias-bg-skeleton);animation:cb-pulse 1.4s ease-in-out infinite;}
@keyframes cb-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.cb-spin{animation:cb-rot 1s linear infinite;}
@keyframes cb-rot{to{transform:rotate(360deg)}}
.cb-mono{font-variant-numeric:tabular-nums;}
.cb-nofx{animation:none!important;transition:none!important;}
`;

    let cssInjected = false;
    function ensureCss() {
      if (cssInjected) return;
      if (typeof document === 'undefined') return;
      if (document.getElementById('dsh-collab-board-css')) { cssInjected = true; return; }
      const el = document.createElement('style');
      el.id = 'dsh-collab-board-css';
      el.textContent = CSS;
      document.head.appendChild(el);
      cssInjected = true;
    }

    /* ────────────────────────────── 小工具 ────────────────────────────── */

    function apiUrl(path) {
      return API + path;
    }

    async function fetchJson(path, init) {
      const res = await fetch(apiUrl(path), {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json', ...(init && init.headers ? init.headers : {}) },
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok || (data && data.ok === false)) {
        const why = data && data.error ? data.error : 'HTTP ' + res.status;
        throw new Error(why);
      }
      return data || {};
    }

    function postEvent(body) {
      return fetchJson('/post', { method: 'POST', body: JSON.stringify(body) });
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function toDate(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function fmtClock(iso) {
      const d = toDate(iso);
      if (!d) return '';
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function fmtShort(iso) {
      const d = toDate(iso);
      if (!d) return '';
      const now = new Date();
      const sameYear = d.getFullYear() === now.getFullYear();
      return (sameYear ? '' : String(d.getFullYear()) + '-') + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function relTime(iso) {
      const d = toDate(iso);
      if (!d) return '';
      const diff = Date.now() - d.getTime();
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
      if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
      return fmtShort(iso);
    }

    function fmtSize(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function fmtTime(iso, mode) {
      if (!iso) return '';
      return mode === 'relative' ? relTime(iso) : fmtClock(iso);
    }

    /** 稳定哈希 → 头像 token 下标。origin 优先，没 origin 用名字。 */
    function hashIndex(text, len) {
      let hash = 2166136261;
      const s = String(text || '');
      for (let i = 0; i < s.length; i += 1) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash) % len;
    }

    function initials(name) {
      const chars = Array.from(String(name || '?').trim());
      return chars.length ? chars[0].toUpperCase() : '?';
    }

    function isOnline(status) {
      return status === 'idle' || status === 'busy';
    }

    /**
     * 事件排序：`(epoch, seq, id)` 升序。
     * epoch / seq 必须按数值比，id 按字典序 —— 写成字符串比较会把 seq=10 排到 9 前面。
     */
    function compareEvents(a, b) {
      const ea = Number(a && a.epoch) || 0;
      const eb = Number(b && b.epoch) || 0;
      if (ea !== eb) return ea - eb;
      const sa = Number(a && a.seq) || 0;
      const sb = Number(b && b.seq) || 0;
      if (sa !== sb) return sa - sb;
      const ia = typeof (a && a.id) === 'string' ? a.id : '';
      const ib = typeof (b && b.id) === 'string' ? b.id : '';
      if (ia < ib) return -1;
      if (ia > ib) return 1;
      return 0;
    }

    function textList(v, max) {
      if (!Array.isArray(v)) return [];
      const out = [];
      for (const item of v) {
        if (typeof item !== 'string' || item.trim() === '') continue;
        out.push(item.trim());
        if (out.length >= (max || 99)) break;
      }
      return out;
    }

    /**
     * 一条 note 说的是哪张卡（0.11.4）。返回 '' = 全局的，不属于任何卡。
     *
     * 为什么需要它：动态流以前把所有 note 一视同仁全摊出来，于是**删掉的卡**
     * 留下的「自动认领: xxx」「一条事件被 Hub 拒了」还能在流里挂一辈子 ——
     * 卡清了、流没清，看着就像没删干净。
     *
     * 判据分两档，原则是**认不出来就当全局**：宁可多留一条，也不能猜错卡，
     * 把不相关的记录一起藏掉。
     *   1. 读字段：0.11.4 起插件自己写 note 会带 `taskId`
     *   2. 读文案：老数据没字段，只能反解 —— **只认我们自己生成的那两种格式**，
     *      格式由生成端保证（见 host/index.mjs 的「自动认领：」和「一条事件被 Hub 拒了（task …）」）
     */
    function noteTaskIdOf(ev, text) {
      const direct = typeof ev.taskId === 'string' ? ev.taskId.trim()
        : (typeof ev.task === 'string' ? ev.task.trim() : '');
      if (direct) return direct;
      const auto = /^自动认领：(\S+)/.exec(text);
      if (auto) return auto[1];
      const rejected = /被 Hub 拒了（task (\S+?)）/.exec(text);
      if (rejected) return rejected[1];
      return '';
    }

    /**
     * 这条事件拿到 Hub 分配的序号没有（= 已同步）。
     *
     * 新事件（带 `eventVersion`）必须真的有 epoch + seq 才算同步 —— 光有 id 不算，
     * id 在本地写的时候就有了。0.1.0 的老事件压根没有同步概念，一律当已同步，
     * 否则一打开就是一屏灰点。
     */
    function hasSyncStamp(ev) {
      if (!ev) return false;
      if (ev.eventVersion !== undefined) {
        return Number.isFinite(ev.epoch) && Number.isFinite(ev.seq);
      }
      return true;
    }

    /* ────────────────────────────── 数据模型 ────────────────────────────── */

    /**
     * 把事件流折成面板要用的形状。面板不自己算业务规则，只做「后写覆盖」和索引。
     * 老数据（0.1.0，没有 epoch/seq/id，task 用 id 不用 taskId）也要能看，
     * 所以每个字段都从两种写法里取，取不到才用默认值。
     */
    function buildModel(events, maxReplay) {
      const all = Array.isArray(events) ? events : [];
      const limit = Math.max(1, Number(maxReplay) || 500);
      const visible = all.length > limit ? all.slice(all.length - limit) : all;
      const ordered = visible
        .map((ev, index) => ({ ev, index }))
        .sort((x, y) => compareEvents(x.ev, y.ev) || x.index - y.index)
        .map((x) => x.ev);

      const tasks = new Map();
      const messages = [];
      const artifacts = [];
      const notes = [];
      const members = new Map();
      const progress = new Map();
      const fileIds = new Set();
      let hub = null;
      let hasFork = false;

      for (const ev of ordered) {
        if (!ev || typeof ev !== 'object') continue;
        const kind = ev.kind;

        if (kind === 'task') {
          const id = String(ev.taskId || ev.id || '').trim();
          if (!id) continue;
          /**
           * 墓碑（0.10.14）：折叠成空壳。
           * 正文在所有机器上都不再从这张卡读出来 —— 日志留着（同步不断），内容当空。
           */
          if (ev.deleted === true) {
            tasks.set(id, {
              taskId: id,
              title: '',
              owner: '',
              status: 'cancelled',
              detail: '',
              dependsOn: [],
              requiredCapabilities: [],
              priority: 'normal',
              tags: [],
              dueAt: '',
              archived: false,
              deleted: true,
              deletedAt: typeof ev.deletedAt === 'string' ? ev.deletedAt : ev.ts || '',
              claimedAt: '',
              leaseMs: 0,
              versions: [],
              createdTs: ev.ts,
              updatedTs: ev.ts,
              ev,
            });
            continue;
          }
          const prev = tasks.get(id) || {
            taskId: id,
            title: id,
            owner: '',
            status: 'pending',
            detail: '',
            dependsOn: [],
            requiredCapabilities: [],
            priority: 'normal',
            tags: [],
            dueAt: '',
            archived: false,
            claimedAt: '',
            leaseMs: 0,
            versions: [],
            createdTs: ev.ts,
            ev,
          };
          const status = STATUS_LABEL[ev.status] ? ev.status : (prev.status || 'pending');
          const next = {
            ...prev,
            title: typeof ev.title === 'string' && ev.title.trim() !== '' ? ev.title.trim() : prev.title,
            owner: typeof ev.owner === 'string' ? ev.owner.trim() : prev.owner,
            status,
            detail: typeof ev.detail === 'string' ? ev.detail : prev.detail,
            dependsOn: Array.isArray(ev.dependsOn) ? textList(ev.dependsOn, 20) : prev.dependsOn,
            requiredCapabilities: Array.isArray(ev.requiredCapabilities)
              ? textList(ev.requiredCapabilities, 20)
              : prev.requiredCapabilities,
            priority: ['high', 'normal', 'low'].includes(ev.priority) ? ev.priority : prev.priority,
            tags: Array.isArray(ev.tags) ? textList(ev.tags, 8) : prev.tags,
            dueAt: typeof ev.dueAt === 'string' ? ev.dueAt : prev.dueAt,
            archived: typeof ev.archived === 'boolean' ? ev.archived : prev.archived,
            claimedAt: typeof ev.claimedAt === 'string' ? ev.claimedAt : prev.claimedAt,
            leaseMs: Number.isFinite(Number(ev.leaseMs)) ? Number(ev.leaseMs) : prev.leaseMs,
            updatedTs: ev.ts,
            ev,
            versions: prev.versions.concat([{
              ts: ev.ts,
              status: ev.status || '',
              title: typeof ev.title === 'string' ? ev.title : '',
              owner: typeof ev.owner === 'string' ? ev.owner : '',
              priority: ev.priority || '',
              archived: ev.archived,
              ev,
            }]),
          };
          tasks.set(id, next);
          continue;
        }

        if (kind === 'msg') {
          messages.push({
            ev,
            ts: ev.ts,
            from: typeof ev.from === 'string' && ev.from.trim() !== '' ? ev.from.trim() : '本机',
            text: String(ev.text == null ? '' : ev.text),
            taskId: typeof ev.taskId === 'string' ? ev.taskId : (typeof ev.task === 'string' ? ev.task : ''),
            replyTo: typeof ev.replyTo === 'string' ? ev.replyTo : '',
            tsKey: ev.ts,
          });
          continue;
        }

        if (kind === 'artifact') {
          const transfer = ev.transfer && typeof ev.transfer === 'object' ? ev.transfer : null;
          if (transfer && typeof transfer.fileId === 'string' && transfer.fileId) fileIds.add(transfer.fileId);
          artifacts.push({
            ev,
            ts: ev.ts,
            taskId: typeof ev.taskId === 'string' ? ev.taskId : (typeof ev.task === 'string' ? ev.task : ''),
            path: typeof ev.path === 'string' ? ev.path : '',
            note: typeof ev.note === 'string' ? ev.note : '',
            transfer,
            derivedFrom: textList(ev.derivedFrom, 8),
            openable: ev.openable !== false,
          });
          continue;
        }

        if (kind === 'progress') {
          const id = String(ev.taskId || ev.task || '').trim();
          if (id) {
            progress.set(id, {
              done: Number.isFinite(Number(ev.done)) ? Number(ev.done) : 0,
              total: Number.isFinite(Number(ev.total)) ? Number(ev.total) : 0,
              note: typeof ev.note === 'string' ? ev.note : '',
              ts: ev.ts,
            });
          }
          continue;
        }

        if (kind === 'note') {
          const noteText = String(ev.text == null ? '' : ev.text);
          notes.push({
            ev,
            ts: ev.ts,
            text: noteText,
            level: ev.level === 'warn' ? 'warn' : 'info',
            // 属于哪张卡（0.11.4）：卡被删掉时，这条也要跟着从动态流里消失
            taskId: noteTaskIdOf(ev, noteText),
          });
          continue;
        }

        if (kind === 'member') {
          const target = String(ev.target || ev.origin || ev.name || '').trim();
          if (!target) continue;
          // 离开就删掉，别留成「离线成员」——0.10.5 刚清完幽灵，别再养一只。
          if (ev.action === 'leave') { members.delete(target); continue; }
          const prev = members.get(target) || { origin: target, name: target, status: 'offline', capabilities: [], seenAt: ev.ts };
          const caps = Array.isArray(ev.capabilities) ? textList(ev.capabilities, 20) : prev.capabilities;
          const status = ev.status === 'idle' || ev.status === 'busy' || ev.status === 'offline' ? ev.status : prev.status;
          members.set(target, {
            ...prev,
            name: typeof ev.name === 'string' && ev.name.trim() !== '' ? ev.name.trim() : prev.name,
            status,
            capabilities: caps,
            seenAt: ev.ts,
            action: ev.action || '',
          });
          continue;
        }

        if (kind === 'hub') {
          hub = {
            name: typeof ev.name === 'string' ? ev.name : '',
            host: typeof ev.host === 'string' ? ev.host : '',
            port: Number.isFinite(Number(ev.port)) ? Number(ev.port) : 0,
            needCode: Boolean(ev.needCode),
            epoch: Number.isFinite(Number(ev.epoch)) ? Number(ev.epoch) : 0,
            ts: ev.ts,
          };
          if (ev.fork === true) hasFork = true;
        }
      }

      const list = [...tasks.values()].sort((a, b) => {
        const pa = { high: 2, normal: 1, low: 0 }[a.priority] == null ? 1 : { high: 2, normal: 1, low: 0 }[a.priority];
        const pb = { high: 2, normal: 1, low: 0 }[b.priority] == null ? 1 : { high: 2, normal: 1, low: 0 }[b.priority];
        if (pa !== pb) return pb - pa;
        return compareEvents(a.ev, b.ev);
      });

      const byTask = new Map();
      for (const m of messages) {
        if (!m.taskId) continue;
        if (!byTask.has(m.taskId)) byTask.set(m.taskId, []);
        byTask.get(m.taskId).push(m);
      }
      const artifactsByTask = new Map();
      for (const f of artifacts) {
        if (!f.taskId) continue;
        if (!artifactsByTask.has(f.taskId)) artifactsByTask.set(f.taskId, []);
        artifactsByTask.get(f.taskId).push(f);
      }

      const senders = new Map();
      for (const m of messages) {
        if (!senders.has(m.from)) senders.set(m.from, m.ts);
      }

      /**
       * 已经删掉的卡（墓碑）的 id 集合（0.11.4）。
       *
       * 「清空任务」就该是「清空跟它有关的一切」—— 卡没了，它的评论、它的系统提示
       * 都不该还在动态流里挂着。这里只放 `deleted === true` 的：
       * `archived` 不算，归档只是不进主视图，卡还活着，它的对话也该还看得到。
       */
      const deletedIds = new Set();
      for (const t of tasks.values()) {
        if (t.deleted === true) deletedIds.add(t.taskId);
      }

      return {
        events: ordered,
        total: all.length,
        truncated: all.length > limit,
        shown: ordered.length,
        tasks: list,
        byId: tasks,
        deletedIds,
        messages,
        notes,
        artifacts,
        artifactsByTask,
        commentsByTask: byTask,
        progress,
        members: [...members.values()],
        senders,
        hub,
        hasFork,
        fileIds,
      };
    }

    /* ────────────────────────────── 原子组件 ────────────────────────────── */

    function Pill(props) {
      return h('span', {
        className: 'cb-pill',
        'data-tone': props.tone || undefined,
        title: props.title || undefined,
      }, props.children);
    }

    function Dot(props) {
      return h('span', { className: 'cb-dot', 'data-tone': props.tone || undefined, title: props.title || undefined });
    }

    function Avatar(props) {
      const name = props.name || '?';
      const token = AVATAR_TOKENS[hashIndex(props.seed || name, AVATAR_TOKENS.length)];
      return h('div', {
        className: 'cb-avatar',
        'data-sm': props.small ? '' : undefined,
        style: { '--cb-av': 'var(' + token + ')' },
        title: props.title || name,
      }, initials(name));
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        className: 'cb-btn',
        'data-primary': props.primary ? '' : undefined,
        'data-ghost': props.ghost ? '' : undefined,
        'data-danger': props.danger ? '' : undefined,
        'data-sm': props.small ? '' : undefined,
        disabled: props.disabled || undefined,
        title: props.title || undefined,
        onClick: props.onClick,
      }, props.children);
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        className: 'cb-sw',
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        'data-on': props.on ? '' : undefined,
        disabled: props.disabled || undefined,
        title: props.title || undefined,
        onClick: props.onClick ? () => props.onClick(!props.on) : undefined,
      });
    }

    function Empty(props) {
      return h('div', { className: 'cb-empty' },
        props.icon ? h('div', { className: 'cb-empty-icon' }, props.icon) : null,
        props.title ? h('div', { className: 'cb-empty-title' }, props.title) : null,
        props.desc ? h('div', { className: 'cb-empty-desc' }, props.desc) : null,
        props.children || null,
      );
    }

    function Icon(props) {
      const name = props.name;
      const size = props.size || 14;
      const common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      };
      const paths = {
        board: [h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 16, rx: 3 }), h('path', { key: 'b', d: 'M3 9h18M9 9v11' })],
        members: [
          h('circle', { key: 'a', cx: 9, cy: 8, r: 3.2 }),
          h('path', { key: 'b', d: 'M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5' }),
          h('path', { key: 'c', d: 'M16 5.5a3 3 0 0 1 0 5.8M17 14c2.2.4 3.5 2.2 3.5 4.6' }),
        ],
        plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
        back: [h('path', { key: 'a', d: 'M15 5l-7 7 7 7' })],
        file: [
          h('path', { key: 'a', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
          h('path', { key: 'b', d: 'M14 3v5h5' }),
        ],
        chat: [h('path', { key: 'a', d: 'M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.4A7.5 7.5 0 1 1 20 12z' })],
        inbox: [h('path', { key: 'a', d: 'M4 13h4l1.5 2h5L16 13h4' }), h('path', { key: 'b', d: 'M4 13l2-7h12l2 7v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' })],
        hub: [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 2.5 }),
          h('path', { key: 'b', d: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1' }),
        ],
        warn: [h('path', { key: 'a', d: 'M12 4l9 16H3z' }), h('path', { key: 'b', d: 'M12 10v4M12 17h.01' })],
        copy: [h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }), h('path', { key: 'b', d: 'M5 15V5a2 2 0 0 1 2-2h10' })],
        refresh: [h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.5 6.5M20 5v6h-6' })],
        check: [h('path', { key: 'a', d: 'M5 13l4 4L19 7' })],
        settings: [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 3 }),
          h('path', { key: 'b', d: 'M12 3v2M12 19v2M4.5 7.5l1.7 1.7M17.8 14.8l1.7 1.7M3 12h2M19 12h2M4.5 16.5l1.7-1.7M17.8 9.2l1.7-1.7' }),
        ],
      };
      return h('svg', common, paths[name] || paths.board);
    }

    /* ────────────────────────────── 看板：列表 ────────────────────────────── */

    function TaskRow(props) {
      const task = props.task;
      const model = props.model;
      const timeMode = props.timeMode;
      const comments = model.commentsByTask.get(task.taskId) || [];
      const prog = model.progress.get(task.taskId);
      const done = task.status === 'done';
      const blockedBy = task.dependsOn.filter((id) => {
        const dep = model.byId.get(id);
        return !dep || (dep.status !== 'done' && dep.status !== 'cancelled');
      });
      const unsynced = props.showSync && !hasSyncStamp(task.ev);

      const tags = task.tags.slice(0, 2);
      const moreTags = task.tags.length - tags.length;
      const dueSoon = task.dueAt
        ? (new Date(task.dueAt).getTime() - Date.now()) < 24 * 60 * 60 * 1000
        : false;

      return h('div', {
        className: 'cb-task',
        'data-on': props.active ? '' : undefined,
        'data-pri': task.priority,
        'data-done': done ? '' : undefined,
        'data-archived': task.archived ? '' : undefined,
        onClick: () => props.onSelect(task.taskId),
        onContextMenu: (e) => { e.preventDefault(); props.onMenu(e, task); },
        title: task.title,
      },
        h('div', { className: 'cb-row' },
          task.deleted
            ? h(Pill, { tone: 'off' }, '已删除')
            : h(Pill, { tone: STATUS_TONE[task.status] }, STATUS_LABEL[task.status] || task.status),
          task.priority === 'high' && !task.deleted ? h('span', { className: 'cb-pdot', title: '高优先级' }) : null,
          h('div', { className: 'cb-task-title' }, task.deleted ? '（已删除）' : task.title),
          unsynced ? h(Dot, { tone: 'sync', title: '还没同步' }) : null,
          h('div', { className: 'cb-meta-right' },
            task.owner
              ? h(Avatar, { name: task.owner, seed: task.owner, small: true, title: task.owner })
              : (task.status === 'pending' ? h('span', { className: 'cb-hint' }, '待接取') : null),
          ),
        ),
        h('div', { className: 'cb-meta' },
          h('span', { className: 'cb-meta-id' }, task.taskId),
          h('span', {
            className: 'cb-meta-text',
            style: dueSoon ? { color: 'var(--dsw-alias-label-error)' } : undefined,
          },
            task.status === 'blocked' && blockedBy.length
              ? '等待 ' + blockedBy.join('、') + ' 完成'
              : (task.dueAt
                ? '截止 ' + (timeMode === 'relative' ? relTime(task.dueAt) : fmtShort(task.dueAt))
                : (comments.length ? comments.length + ' 条评论' : (task.owner || '还没人认领'))),
          ),
          tags.map((tag) => h(Pill, { key: 'tag-' + tag }, tag)),
          moreTags > 0 ? h(Pill, null, '+' + moreTags) : null,
          prog && prog.total > 0
            ? h('span', { className: 'cb-bar', title: prog.done + ' / ' + prog.total },
              h('i', { style: { width: Math.max(2, Math.min(100, Math.round((prog.done / prog.total) * 100))) + '%' } }))
            : null,
        ),
      );
    }

    function BoardList(props) {
      const { model, settings, filter, setFilter, showDone, setShowDone, showArchived, setShowArchived } = props;
      const tasks = model.tasks;
      const counts = useMemo(() => ({
        pending: tasks.filter((t) => t.status === 'pending').length,
        running: tasks.filter((t) => t.status === 'running').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
        done: tasks.filter((t) => t.status === 'done').length,
        archived: tasks.filter((t) => t.archived).length,
      }), [tasks]);

      const filtered = tasks.filter((t) => {
        // 墓碑默认不显示（设置里「显示已删除」可开），归档的仍然按老规矩
        if (t.deleted && !settings.showDeleted) return false;
        if (t.archived && !showArchived) return false;
        if (t.status === 'done' && !showDone) return false;
        if (filter === 'all') return true;
        return t.status === filter;
      });

      return h(Fragment, null,
        h('div', { className: 'cb-toolbar' },
          [['all', '全部'], ['pending', '待认领'], ['running', '进行中'], ['blocked', '已阻塞']].map(([k, label]) =>
            h('button', {
              key: k,
              type: 'button',
              className: 'cb-filter',
              'data-on': filter === k ? '' : undefined,
              onClick: () => setFilter(k),
            }, label),
          ),
          h('span', { className: 'cb-grow' }),
          h('button', {
            type: 'button',
            className: 'cb-filter',
            'data-on': showDone ? '' : undefined,
            /**
             * 已完成的卡只在「全部」筛选下可见（filter 是「进行中」时 done 永远过不来）。
             * 所以点开它时顺手切到「全部」—— 否则按钮亮了、列表还是空的，
             * 人只会以为按钮坏了（2026-11-07 用户实测）。
             */
            onClick: () => {
              const next = !showDone;
              setShowDone(next);
              if (next && filter !== 'all') setFilter('all');
            },
            title: '显示 / 收起已完成（会切到「全部」）',
          }, '已完成' + (counts.done ? ' ' + counts.done : '')),
          counts.archived
            ? h('button', {
              type: 'button',
              className: 'cb-filter',
              'data-on': showArchived ? '' : undefined,
              onClick: () => setShowArchived(!showArchived),
            }, '归档 ' + counts.archived)
            : null,
        ),
        model.truncated
          ? h('div', { className: 'cb-hint', style: { padding: '0 4px 6px' } },
            '只拉到最近 ' + model.shown + ' 条（总共 ' + model.total + ' 条）')
          : null,
        h('div', { className: 'cb-scroll' },
          props.creating ? h(NewTask, {
            onSubmit: props.onCreate,
            onCancel: () => props.setCreating(false),
          }) : null,
          filtered.length === 0
            ? h(Empty, {
              icon: h(Icon, { name: 'inbox', size: 18 }),
              title: props.creating ? '写个标题就行' : (tasks.length === 0 ? '还没有任务' : '这个筛选下没有任务'),
              desc: tasks.length === 0
                ? '在上面点「+ 新建」，或者让 agent 用 collab_post 写一张任务卡。'
                : '换一个筛选看看，或者新建一条。',
            })
            : filtered.map((task) => h(TaskRow, {
              key: task.taskId,
              task,
              model,
              timeMode: settings.timeFormat,
              showSync: settings.role !== 'solo',
              active: props.selectedId === task.taskId,
              onSelect: props.onSelect,
              onMenu: props.onMenu,
            })),
        ),
      );
    }

    function NewTask(props) {
      const [title, setTitle] = useState('');
      const [busy, setBusy] = useState(false);
      const ref = useRef(null);
      useEffect(() => { if (ref.current) ref.current.focus(); }, []);
      const submit = async () => {
        const text = title.trim();
        if (text === '' || busy) return;
        setBusy(true);
        try { await props.onSubmit(text); } finally { setBusy(false); }
      };
      return h('div', { className: 'cb-card', style: { padding: '9px 10px', marginBottom: 4 } },
        h('input', {
          ref,
          className: 'cb-input',
          placeholder: '任务标题，回车创建',
          value: title,
          disabled: busy,
          onChange: (e) => setTitle(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') props.onCancel();
          },
        }),
        h('div', { className: 'cb-hint', style: { paddingTop: 4 } }, '创建后是「待认领」。认领要走 Hub，下一轮接。'),
      );
    }

    /* ────────────────────────────── 看板：详情 ────────────────────────────── */

    function TaskDetail(props) {
      const { task, model, settings, me, toast, onOpenTask } = props;
      const hub = props.hub || null;
      const [historyOpen, setHistoryOpen] = useState(false);
      const [confirmClaim, setConfirmClaim] = useState(false);
      const [busy, setBusy] = useState('');
      const comments = model.commentsByTask.get(task.taskId) || [];
      const artifacts = model.artifactsByTask.get(task.taskId) || [];
      const now = Date.now();

      const deps = task.dependsOn.map((id) => {
        const dep = model.byId.get(id);
        return { id, title: dep ? dep.title : id, status: dep ? dep.status : 'missing' };
      });
      const unmet = deps.filter((d) => d.status !== 'done' && d.status !== 'cancelled');

      const leaseEnd = task.claimedAt && task.leaseMs > 0 ? new Date(task.claimedAt).getTime() + task.leaseMs : 0;
      const leaseLeft = leaseEnd ? leaseEnd - now : 0;
      const leaseWarn = leaseLeft > 0 && leaseLeft < 5 * 60 * 1000;
      const dueSoon = task.dueAt ? (new Date(task.dueAt).getTime() - now < 24 * 60 * 60 * 1000) : false;
      const dueOver = task.dueAt ? (new Date(task.dueAt).getTime() < now) : false;

      const patchTask = async (patch, note) => {
        setBusy(note);
        try {
          await props.onPost({
            kind: 'task',
            id: task.taskId,
            taskId: task.taskId,
            title: task.title,
            owner: task.owner,
            status: task.status,
            detail: task.detail,
            dependsOn: task.dependsOn,
            requiredCapabilities: task.requiredCapabilities,
            priority: task.priority,
            tags: task.tags,
            dueAt: task.dueAt || undefined,
            archived: task.archived,
            ...patch,
          });
          toast(note === 'done' ? '已标记完成' : '已更新');
        } catch (e) {
          toast('没写进去：' + e.message, 'error');
        } finally {
          setBusy('');
        }
      };

      /** 能不能认领：得连上 Hub（认领是 Hub 的串行 CAS，本地做不了）。 */
      const canClaim = Boolean(hub && hub.client && hub.client.online);

      const doClaim = async () => {
        if (busy) return;
        setBusy('claim');
        try {
          await props.onClaim(task.taskId, {});
          toast('已认领');
        } catch (e) {
          if (e.code === 'conflict') toast('认领失败：' + (e.message || '别人先认领了'), 'error');
          else if (e.code === 'blocked') toast('认领失败：依赖没完成（' + ((e.blockedBy || []).join('、') || '未知') + '）', 'error');
          else if (e.code === 'bad-param') toast('认领失败：参数不对', 'error');
          else toast('认领失败：' + e.message, 'error');
        } finally {
          setBusy('');
        }
      };


      return h('div', { className: 'cb-detail' },
        h('div', { className: 'cb-detail-scroll' },
          /* 1. 标题 + 操作 */
          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-detail-top' },
              h('div', { className: 'cb-detail-top-main' },
                h('h2', { className: 'cb-detail-title' }, task.title),
                h('div', { className: 'cb-detail-meta' },
                  h(Pill, { tone: STATUS_TONE[task.status] }, STATUS_LABEL[task.status] || task.status),
                  h(Pill, { tone: task.priority === 'high' ? 'high' : (task.priority === 'low' ? 'low' : undefined) },
                    '优先级 ' + PRIORITY_LABEL[task.priority]),
                  task.tags.map((tag) => h(Pill, { key: 'dt-' + tag }, tag)),
                  task.archived ? h(Pill, null, '已归档') : null,
                ),
              ),
              h('div', { className: 'cb-actions' },
                task.status === 'pending' && !task.owner
                  ? h(Btn, {
                    primary: true,
                    disabled: Boolean(busy) || unmet.length > 0 || !canClaim,
                    title: unmet.length
                      ? '还有依赖没完成：' + unmet.map((u) => u.id).join('、')
                      : (!canClaim ? '还没连上 Hub —— 认领要走 Hub 的串行通道，两个人同时点只有一个成功' : '认领这条任务'),
                    onClick: doClaim,
                  }, busy === 'claim' ? '认领中…' : '认领任务')
                  : null,
                task.status === 'running'
                  ? h(Btn, {
                    primary: true,
                    disabled: Boolean(busy),
                    onClick: () => patchTask({ status: 'done' }, 'done'),
                  }, busy === 'done' ? '写入中…' : '标记完成')
                  : null,
                task.status === 'done'
                  ? h(Btn, { disabled: Boolean(busy), onClick: () => patchTask({ status: 'running' }, 'reopen') }, '重新打开')
                  : null,
                h(Btn, {
                  small: true,
                  disabled: Boolean(busy),
                  onClick: () => patchTask({ archived: !task.archived }, 'archive'),
                }, task.archived ? '取消归档' : '归档'),
              ),
            ),
            task.dueAt
              ? h('div', {
                className: (dueOver || dueSoon) ? 'cb-errline' : 'cb-hint',
                style: { marginTop: 8 },
              }, '截止 ' + fmtShort(task.dueAt) + (dueOver ? '（已过期）' : dueSoon ? '（24 小时内）' : ''))
              : null,
            leaseEnd
              ? h('div', { className: leaseWarn ? 'cb-warnline' : 'cb-hint', style: { marginTop: 6 } },
                leaseLeft > 0
                  ? '剩余租约 ' + Math.ceil(leaseLeft / 60000) + ' 分钟'
                  : '租约已到期')
              : null,
          ),

          /* 2. 任务信息 */
          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-card-h' }, '任务信息'),
            task.detail
              ? h('div', { style: { fontSize: '11.5px', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, task.detail)
              : h('div', { className: 'cb-hint' }, '没有写描述。'),
            h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 } },
              deps.length === 0
                ? h('div', { className: 'cb-hint' }, '前置任务：无')
                : deps.map((dep) => h('div', {
                  key: 'dep-' + dep.id,
                  className: 'cb-dep',
                  'data-bad': unmet.some((u) => u.id === dep.id) ? '' : undefined,
                  'data-good': unmet.some((u) => u.id === dep.id) ? undefined : '',
                },
                  h('span', null, '前置 ' + dep.id),
                  h('button', {
                    type: 'button',
                    className: 'cb-linkish',
                    onClick: () => onOpenTask(dep.id),
                  }, dep.title),
                  h('span', null, '（' + (dep.status === 'missing' ? '不存在' : (STATUS_LABEL[dep.status] || dep.status)) + '）'),
                )),
            ),
            h('div', { style: { marginTop: 6 } },
              h('button', {
                type: 'button',
                className: 'cb-linkish',
                style: { fontSize: '11px' },
                onClick: () => setHistoryOpen(!historyOpen),
              }, historyOpen ? '收起修改历史' : '修改历史（' + task.versions.length + '）'),
              historyOpen
                ? h('div', { style: { marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 } },
                  task.versions.slice().reverse().map((v, i) => h('div', {
                    key: 'v-' + i,
                    className: 'cb-hint',
                  }, fmtShort(v.ts) + ' · ' + (STATUS_LABEL[v.status] || v.status || '—') +
                    (v.title ? ' · ' + v.title : '') + (v.owner ? ' · ' + v.owner : ''))))
                : null,
            ),
          ),

          /* 3. 产出文件 */
          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-card-h' }, '产出文件', h('span', { className: 'cb-grow' }),
              h('span', { className: 'cb-hint' }, artifacts.length ? artifacts.length + ' 个' : '')),
            artifacts.length === 0
              ? h('div', { className: 'cb-hint', style: { padding: '4px 0' } }, '这个任务还没有产出。')
              : artifacts.map((f, i) => h(ArtifactRow, {
                key: 'f-' + i,
                file: f,
                model,
              })),
          ),

          /* 4. 评论 */
          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-card-h' }, '任务评论', h('span', { className: 'cb-grow' }),
              h('span', { className: 'cb-hint' }, comments.length ? comments.length + ' 条 · 最新在上' : '只在本任务可见')),
            comments.length === 0
              ? h('div', { className: 'cb-hint', style: { padding: '4px 0' } }, '还没有人在这条任务下说话。')
              : h('div', { style: { display: 'flex', flexDirection: 'column' } },
                comments.slice().reverse().map((m, i) => h(Message, { key: 'c-' + i, msg: m, me, timeMode: settings.timeFormat }))),
            h('div', { className: 'cb-composer', style: { marginTop: 8 } },
              h(CommentBox, {
                placeholder: '在这条任务下回复…（自动带上 ' + task.taskId + '）',
                disabled: Boolean(busy),
                onSend: async (text) => {
                  await props.onPost({ kind: 'msg', taskId: task.taskId, from: me, text });
                },
                onError: (e) => toast('没发出去：' + e.message, 'error'),
              }),
            ),
          ),
        ),
      );
    }

    function ArtifactRow(props) {
      const { file, model } = props;
      const transfer = file.transfer || null;
      const mode = transfer && transfer.mode ? transfer.mode : '';
      const name = (transfer && transfer.name) || file.path || '(未命名)';
      const size = transfer && transfer.size ? fmtSize(transfer.size) : '';
      const dead = Boolean(transfer && transfer.missing === true);
      const sources = file.derivedFrom.map((id) => ({ id, alive: model.fileIds.has(id) }));
      const sub = mode === 'shared'
        ? (file.path || '')
        : mode === 'hub'
          ? ('Hub 文件 · ' + (size || '大小未知'))
          : (file.note || (size || ''));

      return h('div', { className: 'cb-file', 'data-dead': dead ? '' : undefined },
        h('div', { className: 'cb-file-icon' }, h(Icon, { name: 'file', size: 12 })),
        h('div', { className: 'cb-file-main' },
          h('div', { className: 'cb-file-name' }, name),
          sub ? h('div', { className: 'cb-file-sub', title: sub }, sub) : null,
          sources.length
            ? h('div', { className: 'cb-file-sub' }, '来源：' + sources.map((s) => s.alive ? s.id.slice(0, 10) : '源已过期').join('、'))
            : null,
        ),
        dead
          ? h('span', { className: 'cb-hint' }, '文件不可用')
          : mode === 'hub'
            ? h(Btn, {
              small: true,
              ghost: true,
              disabled: true,
              title: 'Hub 的 GET /files/:id 这一版还没接',
            }, '下载')
            : mode === 'shared'
              ? h('span', { className: 'cb-hint', title: '路径是创建者机器上的，插件不负责映射' }, '共享目录')
              : null,
      );
    }

    function Message(props) {
      const { msg, me, timeMode } = props;
      const mine = msg.from === me;
      return h('div', { className: 'cb-msg', 'data-me': mine ? '' : undefined },
        h(Avatar, { name: msg.from, seed: msg.from, small: true }),
        h('div', { className: 'cb-msg-body' },
          h('div', { className: 'cb-msg-name' }, msg.from + ' · ' + fmtTime(msg.ts, timeMode)),
          h('div', { className: 'cb-msg-bubble' }, msg.text || '（空消息）'),
        ),
      );
    }

    function SysNote(props) {
      const note = props.note;
      const [open, setOpen] = useState(false);
      const long = note.text.length > 140;
      return h('div', { className: 'cb-sys' },
        h('span', {
          style: long && !open
            ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : undefined,
        },
          h('em', null, '系统 '),
          note.text),
        long
          ? h('button', {
            type: 'button',
            className: 'cb-linkish',
            style: { fontSize: '10px', marginLeft: 4 },
            onClick: () => setOpen(!open),
          }, open ? '收起' : '展开')
          : null,
      );
    }

    function CommentBox(props) {
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const submit = async () => {
        const t = text.trim();
        if (t === '' || busy) return;
        setBusy(true);
        try {
          await props.onSend(t);
          setText('');
        } catch (e) {
          if (props.onError) props.onError(e);
        } finally {
          setBusy(false);
        }
      };
      return h(Fragment, null,
        h('input', {
          className: 'cb-input',
          placeholder: props.placeholder || '说点什么…',
          value: text,
          disabled: props.disabled || busy,
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
        }),
        h(Btn, { small: true, disabled: props.disabled || busy || text.trim() === '', onClick: submit }, '发送'),
      );
    }

    /* ────────────────────────────── 看板：全局流 ────────────────────────────── */

    function GlobalFeed(props) {
      const { model, settings, me, toast } = props;
      const scrollRef = useRef(null);

      const entries = useMemo(() => {
        const list = [];
        for (const m of model.messages) {
          if (m.taskId) continue;
          list.push({ kind: 'msg', ts: m.ts, data: m });
        }
        for (const note of model.notes) {
          if (!settings.showSystemEvents) continue;
          /**
           * 挂在一张已经删掉的卡上的提示，跟着卡一起消失（0.11.4）。
           *
           * 以前不分卡：卡清空了，那几十条「自动认领: xxx」还挂在流里，
           * 看上去像没删干净。动态流跟着任务走，任务没了它也该没了。
           * 认不出属于哪张卡的 note 一律当全局留着 —— 宁可多留，不能藏错。
           */
          if (note.taskId && model.deletedIds.has(note.taskId)) continue;
          list.push({ kind: 'note', ts: note.ts, data: note });
        }
        if (settings.showArtifacts) {
          for (const f of model.artifacts) {
            if (f.taskId) continue;
            list.push({ kind: 'artifact', ts: f.ts, data: f });
          }
        }
        /**
         * 倒序：最新的在最上面（0.11.6）。
         *
         * 原来按时间升序往下堆、自动滚到底，翻旧消息要一路往上拖；
         * 消息一多，最该看的那条永远在最下面。改成降序，新的直接顶上来。
         *
         * 排序键用 ts；拿不到就按 0 处理 —— 宁可让它沉底，别让整个列表乱序。
         */
        const tsOf = (x) => {
          const v = x && x.ts;
          if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
          const n = Date.parse(String(v || ''));
          return Number.isFinite(n) ? n : 0;
        };
        return list.sort((a, b) => tsOf(b) - tsOf(a));
      }, [model, settings.showSystemEvents, settings.showArtifacts]);

      /**
       * 倒序之后「跟到最新」= 滚到顶部。
       *
       * 只在用户本来就在顶部附近时才跳 —— 翻历史翻到一半被拽回去，比不跟还烦。
       */
      useEffect(() => {
        if (!settings.autoScroll || !scrollRef.current) return;
        if (scrollRef.current.scrollTop < 80) scrollRef.current.scrollTop = 0;
      }, [entries.length, settings.autoScroll]);

      const taskComments = useMemo(() => {
        const rows = [];
        for (const [taskId, list] of model.commentsByTask) {
          const task = model.byId.get(taskId);
          if (task && task.archived) continue;
          /**
           * 卡删了，这条索引也删（0.11.4）。
           *
           * 以前只跳过 `archived`，没跳 `deleted` —— 于是删掉的卡还按评论数排在最前面，
           * 点进去 29 条评论全文都在。「删除」删的是标题，评论一条没动，等于删了个寂寞。
           */
          if (model.deletedIds.has(taskId)) continue;
          rows.push({ taskId, count: list.length, title: task ? task.title : taskId });
        }
        return rows.sort((a, b) => b.count - a.count);
      }, [model]);

      return h('div', { className: 'cb-detail' },
        h('div', { className: 'cb-toolbar' },
          h('span', { className: 'cb-toolbar-title' }, '动态'),
          h('span', { className: 'cb-grow' }),
          h('span', { className: 'cb-hint' }, '任务评论收在各自任务里'),
        ),
        h('div', { className: 'cb-feed-scroll cb-scroll', ref: scrollRef },
          entries.length === 0
            ? h(Empty, {
              icon: h(Icon, { name: 'chat', size: 18 }),
              title: '还没有全局消息',
              desc: '看板里只有任务评论；全局消息会在下面出现。系统提示也走这里。',
            })
            : entries.map((item) => {
              /**
               * key 必须是稳定的。倒序之后用下标当 key，新消息插到最前面时
               * 每一条的下标都变，React 会把上一条的内容复用到下一条上（闪一下、错位）。
               */
              const k = (item.data && item.data.id)
                ? String(item.data.id)
                : `${item.kind}:${item.data && item.data.ts}`;
              if (item.kind === 'msg') {
                return h(Message, { key: k, msg: item.data, me, timeMode: settings.timeFormat });
              }
              if (item.kind === 'note') {
                return h(SysNote, { key: k, note: item.data });
              }
              return h('div', { key: k, className: 'cb-sys', style: { textAlign: 'left' } },
                h('em', null, '产出'), item.data.path || '(文件)');
            }),
          taskComments.map((row) => h('button', {
            key: 'tc-' + row.taskId,
            type: 'button',
            className: 'cb-cmt-row',
            onClick: () => props.onOpenTask(row.taskId),
          },
            h(Icon, { name: 'chat', size: 12 }),
            h('span', { className: 'cb-grow' }, row.taskId + ' · ' + row.title),
            h('span', { className: 'cb-hint' }, row.count + ' 条任务评论'),
          )),
        ),
        h('div', { className: 'cb-composer' },
          h(CommentBox, {
            placeholder: '发一条全局消息…',
            onSend: async (text) => { await props.onPost({ kind: 'msg', from: me, text }); },
            onError: (e) => toast('没发出去：' + e.message, 'error'),
          }),
        ),
      );
    }

    /* ────────────────────────────── 设置 ────────────────────────────── */

    const SETTINGS_TABS = [
      { id: 'identity', label: '身份' },
      { id: 'display', label: '显示' },
      { id: 'connect', label: '连接' },
      { id: 'data', label: '数据' },
      { id: 'danger', label: '高危操作' },
    ];

    function Field(props) {
      return h('div', { className: 'cb-field' },
        h('div', { className: 'cb-field-label' }, props.label),
        h('div', { className: 'cb-field-body' },
          h('div', { className: 'cb-field-row' },
            h('div', { className: 'cb-field-desc' }, props.desc || ''),
            props.control ? h('div', { className: 'cb-field-ctl' }, props.control) : null,
          ),
          props.children || null,
        ),
      );
    }

    /**
     * 输入框草稿：**失焦或回车才提交**。
     * 逐字保存会让「3000」在输入过程中变成 3 / 30 / 300 —— 宿主按范围拒一次，
     * 值就被还原，光标也跟着跳，很难用。
     */
    function DraftInput(props) {
      const [draft, setDraft] = useState(String(props.value === undefined ? '' : props.value));
      useEffect(() => {
        setDraft(String(props.value === undefined ? '' : props.value));
      }, [props.value]);
      const commit = () => {
        const raw = draft.trim();
        if (raw === '') { setDraft(String(props.value === undefined ? '' : props.value)); return; }
        if (props.numeric) {
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            setDraft(String(props.value === undefined ? '' : props.value));
            return;
          }
          if (n !== props.value) props.onCommit(n);
          return;
        }
        if (raw !== props.value) props.onCommit(raw);
      };
      return h('input', {
        className: 'cb-input' + (props.numeric ? ' cb-num' : ''),
        type: props.numeric ? 'number' : 'text',
        min: props.min,
        max: props.max,
        step: props.step,
        value: draft,
        placeholder: props.placeholder,
        maxLength: props.maxLength,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
          if (e.key === 'Escape') setDraft(String(props.value === undefined ? '' : props.value));
        },
      });
    }

    /**
     * 口令输入：**永远不显示已存的值**（宿主已经不回传原文了，页面也不该假装知道）。
     * 输入后回车 / 失焦提交，提交完清空 —— 屏幕上不留明文。
     */
    function SecretDraft(props) {
      const [draft, setDraft] = useState('');
      const commit = () => {
        const v = draft.trim();
        if (v === '') return;
        if (typeof props.onCommit === 'function') props.onCommit(v);
        setDraft('');
      };
      return h('input', {
        className: 'cb-input',
        type: 'password',
        value: draft,
        placeholder: props.placeholder || '输入新口令后回车',
        maxLength: 64,
        autoComplete: 'new-password',
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') setDraft('');
        },
      });
    }

    function SettingsView(props) {
      const { settings, saveSetting, toast, dataDir, onClearData } = props;
      const [tab, setTab] = useState('identity');
      const [confirmClear, setConfirmClear] = useState(false);
      const [confirmReset, setConfirmReset] = useState(false);
      const [confirmPurge, setConfirmPurge] = useState(false);

      const roleSeg = h('div', { className: 'cb-seg' },
        ['solo', 'hub', 'member'].map((r) => h('button', {
          key: r,
          type: 'button',
          className: 'cb-seg-btn',
          'data-on': settings.role === r ? '' : undefined,
          onClick: () => saveSetting('role', r),
        }, ROLE_LABEL[r])),
      );

      const body = {
        identity: h('div', { className: 'cb-card' },
          h('div', { className: 'cb-card-h' }, '身份'),
          h('p', { className: 'cb-card-sub' }, '你在这张看板上是谁。改名只影响显示，不改历史事件。'),
          h('div', { style: { marginTop: 6 } },
            h(Field, {
              label: '角色',
              desc: settings.role === 'solo' ? '本机自己用，不同步' : '和别的设备连，要走 Hub（下一轮接）',
              control: roleSeg,
            }),
            h(Field, {
              label: '显示名',
              desc: '空 = 用主机名。发消息和任务卡上的名字。',
            }, h(DraftInput, {
              value: settings.selfName,
              placeholder: '你的名字',
              maxLength: 64,
              onCommit: (v) => saveSetting('selfName', v),
            })),
          ),
        ),
        display: h('div', { className: 'cb-card' },
          h('div', { className: 'cb-card-h' }, '看板显示'),
          h('p', { className: 'cb-card-sub' }, '这几个开关点完立刻生效。'),
          h('div', { style: { marginTop: 6 } },
            h(Field, {
              label: '系统事件',
              desc: '把系统提示（note）显示在动态流里。',
              control: h(Toggle, {
                on: settings.showSystemEvents,
                onClick: (v) => saveSetting('showSystemEvents', v),
              }),
            }),
            h(Field, {
              label: '产出条目',
              desc: '在动态流里显示没有挂任务的产物。',
              control: h(Toggle, {
                on: settings.showArtifacts,
                onClick: (v) => saveSetting('showArtifacts', v),
              }),
            }),
            h(Field, {
              label: '跟到最新',
              desc: '有新消息时回到顶部（最新的在最上面）。往上翻到一半时不会把你拽回去。',
              control: h(Toggle, {
                on: settings.autoScroll,
                onClick: (v) => saveSetting('autoScroll', v),
              }),
            }),
            h(Field, {
              label: '时间格式',
              desc: '『14:20』或『5 分钟前』。',
              control: h('div', { className: 'cb-seg' },
                [['clock', '时刻'], ['relative', '相对']].map(([k, label]) => h('button', {
                  key: k,
                  type: 'button',
                  className: 'cb-seg-btn',
                  'data-on': settings.timeFormat === k ? '' : undefined,
                  onClick: () => saveSetting('timeFormat', k),
                }, label))),
            }),
            h(Field, {
              label: '回放条数',
              desc: '面板一次最多渲染多少条事件（50～5000）。',
              control: h(DraftInput, {
                numeric: true,
                min: 50,
                max: 5000,
                value: settings.maxReplay,
                onCommit: (v) => saveSetting('maxReplay', v),
              }),
            }),
          ),
        ),
        connect: h('div', { className: 'cb-card' },
          h('div', { className: 'cb-card-h' }, '连接'),
          h('p', { className: 'cb-card-sub' }, '起 Hub 用端口和口令，加入 / 重连用地址。端口和口令即改即生效（Hub 在跑也当场换），不用重启。'),
          h('div', { style: { marginTop: 6 } },
            h(Field, {
              label: '轮询间隔',
              desc: '面板多久拉一次本机日志（1000～60000 毫秒）。',
              control: h(DraftInput, {
                numeric: true,
                min: 1000,
                max: 60000,
                step: 500,
                value: settings.pollIntervalMs,
                onCommit: (v) => saveSetting('pollIntervalMs', v),
              }),
            }),
            h(Field, {
              label: 'Hub 端口',
              desc: '「我来当 Hub」用这个端口（1～65535），默认 48910。',
              control: h(DraftInput, {
                numeric: true,
                min: 1,
                max: 65535,
                step: 1,
                value: settings.hubPort,
                onCommit: (v) => saveSetting('hubPort', v),
              }),
            }),
            h(Field, {
              label: '发现端口',
              desc: 'UDP 自动发现用（1024～65535），默认 48911。48911 被别的程序占了就换一个 —— 两台机器的发现端口要一致才互相看得见。',
              control: h(DraftInput, {
                numeric: true,
                min: 1024,
                max: 65535,
                step: 1,
                value: settings.discoveryPort,
                onCommit: (v) => saveSetting('discoveryPort', v),
              }),
            }),
            h(Field, {
              label: 'Hub 口令',
              desc: settings.hubCodeSet
                ? '已设置（口令不回显，宿主的 HTTP 也不回传原文）。输入新口令回车可重设；留空不改。'
                  + '本机在当 Hub 时改了立刻生效 —— 但挡的是下一次加入，已经在线的成员不受影响。'
                : '未设置。本机当 Hub 时，别人加入要输这个口令；留空 = 不设口令，同网段谁都能连。'
                  + '当成员时这里也可以存一份，加入时留空就用它。',
              control: settings.hubCodeSet
                ? h(Btn, { small: true, onClick: () => saveSetting('hubCode', '') }, '清除口令')
                : null,
            }, h(SecretDraft, { onCommit: (v) => saveSetting('hubCode', v) })),
            h(Field, {
              label: 'Hub 地址',
              desc: '加入别人 Hub 时用，例如 http://192.168.1.5:48910。也可以直接在「成员」页填。',
            }, h(DraftInput, {
              value: settings.hubAddress || '',
              placeholder: 'http://192.168.1.5:48910',
              maxLength: 200,
              onCommit: (v) => saveSetting('hubAddress', v),
            })),
            h(Field, {
              label: '自动认领',
              desc: '启动后定时扫「该我接的活」，符合条件的直接认领。不认自己建的，也不认能力不够的。**认领不等于开干**，agent 还是要被消息触发。',
              control: h(Toggle, {
                on: Boolean(settings.autoClaim),
                onClick: (v) => saveSetting('autoClaim', v),
              }),
            }),
            h(Field, {
              label: '认领间隔',
              desc: '多久扫一次（10000～3600000 毫秒，默认 60 秒）。改完立即生效。',
              control: h(DraftInput, {
                numeric: true,
                min: 10000,
                max: 3600000,
                step: 10000,
                value: settings.autoClaimMs,
                onCommit: (v) => saveSetting('autoClaimMs', v),
              }),
            }),
            h(Field, {
              label: '有新消息自动唤醒',
              desc: '开着时，别人在这个看板发了新消息，就把本机 agent 叫起来读一轮。**会在对话里插一条「协作看板自动触发」**，而且要等它跑完。两台都想自动对话就都开。',
              control: h(Toggle, {
                on: Boolean(settings.wakeOnMessage),
                onClick: (v) => saveSetting('wakeOnMessage', v),
              }),
            }),
            h(Field, {
              label: '唤醒冷却',
              desc: '同一条任务多久内最多唤醒一次（60000～3600000 毫秒，默认 5 分钟）。防两个人互相叫个没完。',
              control: h(DraftInput, {
                numeric: true,
                min: 60000,
                max: 3600000,
                step: 60000,
                value: settings.wakeCooldownMs,
                onCommit: (v) => saveSetting('wakeCooldownMs', v),
              }),
            }),
            h(Field, {
              label: '唤醒重试',
              desc: '一次唤醒最多投几次（1～10，默认 3）。投不出去会留在账本里重试，**重启也会补投**；设 1 等于不重试、只试一次。',
              control: h(DraftInput, {
                numeric: true,
                min: 1,
                max: 10,
                step: 1,
                value: settings.wakeRetries,
                onCommit: (v) => saveSetting('wakeRetries', v),
              }),
            }),
            h(Field, {
              label: '自动续跑',
              desc: '开着时，一轮唤醒投完、那张卡还是 running，就自己再排一次唤醒（到冷却结束再叫自己）。**这是让 agent 不靠别人发消息也能接着转的开关** —— 每转一轮都是一整轮 token，默认关。别人的卡、done、blocked 都不续。',
              control: h(Toggle, {
                on: Boolean(settings.wakeSelfContinue),
                onClick: (v) => saveSetting('wakeSelfContinue', v),
              }),
            }),
            h(Field, {
              label: '续跑上限',
              desc: '同一张卡最多连续续跑几次（1～50，默认 8）。到了写一条 warn note 停下，不会无限刷自己。',
              control: h(DraftInput, {
                numeric: true,
                min: 1,
                max: 50,
                step: 1,
                value: settings.wakeSelfContinueMax,
                onCommit: (v) => saveSetting('wakeSelfContinueMax', v),
              }),
            }),
            settings.hiddenMembers
              ? h(Field, {
                label: '已移除的成员',
                desc: '被你移除的成员只在你这台不显示 —— 不改事件流、不影响别人。',
                control: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { className: 'cb-hint' },
                    String(settings.hiddenMembers).split(',').filter(Boolean).length + ' 位'),
                  h(Btn, { small: true, onClick: () => saveSetting('hiddenMembers', '') }, '全部恢复'),
                ),
              })
              : null,
            h(Field, {
              label: '待办提醒',
              desc: '开着时定时扫「该我接的活」，发现了在动态里写一条。不会自动认领，也不会替你叫醒 agent。',
              control: h(Toggle, {
                on: Boolean(settings.pendingWatch),
                onClick: (v) => saveSetting('pendingWatch', v),
              }),
            }),
            h(Field, {
              label: '提醒间隔',
              desc: '多久扫一次（60000～3600000 毫秒，默认 5 分钟）。改完立即生效。',
              control: h(DraftInput, {
                numeric: true,
                min: 60000,
                max: 3600000,
                step: 60000,
                value: settings.pendingWatchMs,
                onCommit: (v) => saveSetting('pendingWatchMs', v),
              }),
            }),
          ),
        ),
        data: h('div', { className: 'cb-card' },
          h('div', { className: 'cb-card-h' }, '数据'),
          h('p', { className: 'cb-card-sub' }, '事件日志是本机唯一事实源，只追加。'),
          h('div', { style: { marginTop: 6 } },
            h(Field, {
              label: '数据目录',
              desc: '改目录要改 cordis.patch.yml 再重启 DSH —— 不在这里改。',
              control: h('span', { className: 'cb-hint cb-mono', title: dataDir || '' },
                dataDir || '~/.dsh/collab'),
            }),
            h(Field, {
              label: '保留条数',
              desc: '超过就裁掉最老的（100～200000），下次写入时生效。',
              control: h(DraftInput, {
                numeric: true,
                min: 100,
                max: 200000,
                step: 100,
                value: settings.maxEvents,
                onCommit: (v) => saveSetting('maxEvents', v),
              }),
            }),
            h(Field, {
              label: '已结束保留天数',
              desc: '完成 / 取消的卡放多少天后自动立碑（正文擦空）。0 = 永不自动清。',
              control: h(DraftInput, {
                numeric: true,
                min: 0,
                max: 3650,
                step: 1,
                value: settings.retentionDays,
                onCommit: (v) => saveSetting('retentionDays', v),
              }),
            }),
            h(Field, {
              label: '显示已删除',
              desc: '墓碑默认不显示。打开后能看到「已删除」的空壳，用来核对谁在什么时候删的。',
              control: h(Toggle, {
                on: Boolean(settings.showDeleted),
                onClick: (v) => saveSetting('showDeleted', v),
              }),
            }),
          ),
        ),
        danger: h('div', { className: 'cb-card', style: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, var(--dsw-alias-bg-layer-1))' } },
          h('div', { className: 'cb-card-h' }, '高危操作'),
          h('p', { className: 'cb-card-sub' }, '这两个动作不可撤销，都是本机的，不涉及别的设备。'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
            h('div', { className: 'cb-field-row' },
              h('div', { className: 'cb-field-desc' }, '把所有完成 / 取消的卡立碑（正文擦空）。日志不删行，两台机器一致。'),
              h('div', { className: 'cb-field-ctl' },
                confirmPurge
                  ? h(Fragment, null,
                    h(Btn, {
                      small: true,
                      danger: true,
                      onClick: async () => {
                        setConfirmPurge(false);
                        try {
                          const out = await fetchJson('/tasks/delete', {
                            method: 'POST',
                            body: JSON.stringify({ allFinished: true }),
                          });
                          if (out && out.ok === false) throw new Error(out.error || '删除失败');
                          const n = Array.isArray(out?.deleted) ? out.deleted.length : 0;
                          toast(n ? `已清空 ${n} 张已结束的卡` : '没有已结束的卡');
                        } catch (e) {
                          toast('清空失败：' + e.message, 'error');
                        }
                      },
                    }, '确认清空'),
                    h(Btn, { small: true, ghost: true, onClick: () => setConfirmPurge(false) }, '算了'))
                  : h(Btn, { small: true, danger: true, onClick: () => setConfirmPurge(true) }, '清空已结束的卡'),
              ),
            ),
            h('div', { className: 'cb-field-row' },
              h('div', { className: 'cb-field-desc' }, '清空本机事件日志和收件去重记录。'),
              h('div', { className: 'cb-field-ctl' },
                confirmClear
                  ? h(Fragment, null,
                    h(Btn, { small: true, danger: true, onClick: async () => { await onClearData(); setConfirmClear(false); } }, '确认清空'),
                    h(Btn, { small: true, ghost: true, onClick: () => setConfirmClear(false) }, '算了'))
                  : h(Btn, { small: true, danger: true, onClick: () => setConfirmClear(true) }, '清空本地数据'),
              ),
            ),
            h('div', { className: 'cb-field-row' },
              h('div', { className: 'cb-field-desc' }, '角色回到「单机」、显示名清空。'),
              h('div', { className: 'cb-field-ctl' },
                confirmReset
                  ? h(Fragment, null,
                    h(Btn, {
                      small: true,
                      danger: true,
                      onClick: async () => {
                        await saveSetting('role', 'solo');
                        await saveSetting('selfName', '');
                        setConfirmReset(false);
                        toast('组身份已重置');
                      },
                    }, '确认重置'),
                    h(Btn, { small: true, ghost: true, onClick: () => setConfirmReset(false) }, '算了'))
                  : h(Btn, { small: true, danger: true, onClick: () => setConfirmReset(true) }, '重置组身份'),
              ),
            ),
          ),
        ),
      }[tab];

      return h('div', { className: 'cb-settings' },
        h('div', { className: 'cb-settings-nav' },
          SETTINGS_TABS.map((t) => h('button', {
            key: t.id,
            type: 'button',
            className: 'cb-navitem',
            'data-on': tab === t.id ? '' : undefined,
            onClick: () => setTab(t.id),
          }, t.label)),
        ),
        h('div', { className: 'cb-settings-main' }, body),
      );
    }

    /* ────────────────────────────── 成员与连接 ────────────────────────────── */

    function MembersView(props) {
      // presence 必须在这儿解构：它是父组件用 useState 管着的在线态，
      // 0.10.13 往 props 里传了却忘了接，点「成员」直接 ReferenceError。
      const { model, settings, me, toast, onCopy, presence } = props;
      /** 宿主回报的 Hub 运行态（`GET /hub`）。跟事件流里那张 `hub` 卡片不是一回事。 */
      const runtime = props.runtime || null;
      const onHubAction = props.onHubAction;
      const onHideMember = props.onHideMember;
      const [joinAddress, setJoinAddress] = useState('');
      /**
       * 加入别人 Hub 时用的口令（0.11.7 补的）。
       *
       * 之前这里只有地址一个输入框：Hub 设了口令，成员连上来根本没地方填 ——
       * 后台拿本机设置里的 `hubCode` 顶上去（多半是空的），401 只在日志里留一行。
       * 人看到的就是「口令不起作用，也没地方输」。
       */
      const [joinCode, setJoinCode] = useState('');
      const [hubBusy, setHubBusy] = useState('');
      const [ignoredFork, setIgnoredFork] = useState(false);

      const members = useMemo(() => {
        /** 本机 origin：用来把自己从「别人」里剔掉。按名字剔会误伤同名成员。 */
        const selfOrigin = runtime && typeof runtime.origin === 'string' ? runtime.origin : '';
        const liveMap = presence && presence.map ? presence.map : null;

        /**
         * 名单 = 事件流里的 member 事件 ∪ Hub 现报的成员表。
         *
         * 只认事件流会漏人：member 事件只在 join 那一刻写一条，历史没落进本机日志、
         * 日志被清过、或者对方 join 的那条没推上来，面板上就永远看不到这个人 ——
         * 哪怕 Hub 的 /members 明明报着他在线。2026-11-07 用户反馈的
         * 「成员一直在线，成员页却只有自己」就是这个。
         *
         * 但仍然**不**把「只在消息里出现过的名字」折成成员：那种名单认不出 origin，
         * 删不掉也对不上号；Hub 的成员表是有 origin 的权威表，可以信。
         */
        const byOrigin = new Map();
        for (const m of model.members) {
          if (selfOrigin && m.origin === selfOrigin) continue; // 本机单独画，见下
          byOrigin.set(m.origin, { ...m, self: false, inferred: false });
        }
        if (liveMap) {
          for (const [origin, live] of Object.entries(liveMap)) {
            if (!origin || (selfOrigin && origin === selfOrigin)) continue;
            const prev = byOrigin.get(origin);
            const prevName = prev && prev.name && prev.name !== origin ? prev.name : '';
            byOrigin.set(origin, {
              origin,
              name: prevName || live.name || origin,
              status: live.online ? (live.status === 'busy' ? 'busy' : 'idle') : 'offline',
              capabilities: prev && Array.isArray(prev.capabilities) ? prev.capabilities : [],
              seenAt: prev ? prev.seenAt : '',
              live: true,
              self: false,
              inferred: false,
            });
          }
        }

        const others = [...byOrigin.values()].map((m) => {
          /**
           * 在线态以 Hub 现报的为准；拉不到（没连 Hub / 老宿主）才退回事件流里的旧值。
           * 不覆盖的话，断了机的成员会永远挂着「在线」——那比显示离线更误导。
           */
          const live = liveMap ? liveMap[m.origin] : null;
          /**
           * 在线态**只认 Hub 现报的**（0.11.12）：
           *   - 表里有他且 online → 在线；
           *   - 拉到表但表里没他 → 离线（Hub 重启后 token 全失效，成员得重连）；
           *   - 连表都拉不到 → 也说离线 —— 「不知道」画成在线比画成离线误导得多。
           *
           * 以前拉不到就退回事件流里的 `status`，而 `member` 事件是 join 那一刻的快照，
           * 永远写着 idle —— 于是 Hub 重启、对方早就掉了，面板还挂着「2 在线」。
           * 2026-11-07 用户就是照这个数以为汐汐在线，其实 Hub 侧 token 表里只有 1 个。
           */
          const liveStatus = live
            ? (live.online ? (live.status === 'busy' ? 'busy' : 'idle') : 'offline')
            : 'offline';
          return { ...m, status: liveStatus, live: Boolean(live) };
        });

        const selfLive = selfOrigin && liveMap ? liveMap[selfOrigin] : null;
        const self = {
          origin: 'local',
          name: settings.selfName || '本机',
          status: selfLive ? (selfLive.online ? 'idle' : 'offline') : 'idle',
          self: true,
          live: Boolean(selfLive),
        };

        return [self, ...others].sort((a, b) => {
          const oa = a.self ? -1 : (isOnline(a.status) ? 0 : 1);
          const ob = b.self ? -1 : (isOnline(b.status) ? 0 : 1);
          if (oa !== ob) return oa - ob;
          return a.name.localeCompare(b.name);
        });
      }, [model.members, settings.selfName, presence, runtime]);

      /** 本地隐藏的成员（只影响这台机器的视图，不改事件流）。 */
      const hiddenSet = new Set(
        String(settings.hiddenMembers || '').split(',').map((s) => s.trim()).filter(Boolean),
      );
      const visibleMembers = members.filter((m) => !hiddenSet.has(m.origin));
      const online = visibleMembers.filter((m) => m.self || isOnline(m.status)).length;
      const hub = model.hub;
      // Hub 地址：优先宿主回报的（正在跑 / 已连上），再退到事件流里的 hub 卡片
      const livePort = runtime && runtime.server ? runtime.server.port : 0;
      const address = livePort
        ? '本机:' + livePort
        : (hub
          ? (hub.host || '本机') + (hub.port ? ':' + hub.port : '')
          : (runtime && runtime.client && runtime.client.baseUrl ? runtime.client.baseUrl : ''));
      const hubRunning = Boolean(runtime && runtime.server);
      const hubConnected = Boolean(runtime && runtime.client && runtime.client.online);
      const hubOffline = settings.role !== 'solo' && !hub && !hubConnected;

      const doHubAction = async (action, body) => {
        if (!onHubAction || hubBusy) return;
        setHubBusy(action);
        try {
          const out = await onHubAction(action, body);
          if (action === 'start') toast('Hub 已起：端口 ' + ((out && out.info && out.info.port) || '?'));
          else if (action === 'stop') toast(out && out.stopped ? 'Hub 已停' : '本来就没在当 Hub');
          else if (action === 'join') {
            // 连上就把输入的明文口令从界面上擦掉；后台已经存成哈希了
            setJoinCode('');
            toast('已连上 ' + ((out && out.address) || joinAddress));
          }
          else if (action === 'leave') toast('已断开');
          else if (action === 'yield') toast('已断开自己的 Hub，改连 ' + ((out && out.address) || '对方'));
          else if (action === 'dismiss-fork') toast('这次运行不再提示');
        } catch (e) {
          toast('操作失败：' + e.message, 'error');
        } finally {
          setHubBusy('');
        }
      };

      /**
       * 「加入」的入口。地址必填，口令可空 ——
       * 留空 = 对方没设口令（或沿用本机设置里存的，重启后自动重连就靠它）。
       */
      const submitJoin = () => {
        const addr = joinAddress.trim();
        if (!addr || hubBusy) return;
        doHubAction('join', { address: addr, code: joinCode.trim() });
      };

      const copy = async (text, label) => {
        if (!text) {
          toast(label + '还没有内容可复制', 'error');
          return;
        }
        try {
          await onCopy(text);
          toast('已复制' + label);
        } catch (e) {
          toast('复制失败：' + e.message, 'error');
        }
      };

      return h('div', { className: 'cb-members' },
        h('div', { className: 'cb-members-list' },
          h('div', { className: 'cb-toolbar' },
            h('span', { className: 'cb-toolbar-title' }, '成员'),
            h('span', { className: 'cb-grow' }),
            h('span', { className: 'cb-hint' }, online + ' 在线 · ' + members.length + ' 位'),
          ),
          h('div', { className: 'cb-scroll', style: { paddingTop: 2 } },
            visibleMembers.map((m) => h('div', { key: m.origin, className: 'cb-member' },
              h(Avatar, { name: m.name, seed: m.origin }),
              h('div', { className: 'cb-member-main' },
                h('div', { className: 'cb-member-name' },
                  h('span', null, m.name),
                  h(Dot, {
                    tone: m.self || m.status === 'idle' ? 'ok' : (m.status === 'busy' ? 'busy' : 'off'),
                    title: m.self ? '本机' : (m.status === 'busy' ? '忙碌' : (isOnline(m.status) ? '在线' : '离线')),
                  }),
                  m.self ? h('span', { className: 'cb-hint' }, '本机') : null,
                ),
                h('div', { className: 'cb-member-sub' },
                  m.inferred ? '离线 · 只在消息里见过' : (m.status === 'busy' ? '忙碌' : (isOnline(m.status) ? '在线' : '离线')),
                ),
              ),
              m.self
                ? null
                : h('button', {
                  type: 'button',
                  className: 'cb-linkish',
                  style: { fontSize: '11px', flex: 'none', opacity: 0.85 },
                  title: '从这台机器的看板移除（不改事件流、不影响别人；设置 → 连接里能恢复）',
                  onClick: (e) => {
                    e.stopPropagation();
                    if (typeof onHideMember !== 'function') return;
                    onHideMember([...hiddenSet, m.origin].join(','));
                    toast('已移除 ' + m.name + '（只影响这台机器）');
                  },
                }, '移除'),
            )),
            visibleMembers.length <= 1
              ? h('div', { className: 'cb-hint', style: { padding: '8px 8px' } },
                hiddenSet.size > 0
                  ? '还有 ' + hiddenSet.size + ' 位被你移除了。设置 → 连接 → 全部恢复。'
                  : '还没有别的成员。等第二台设备连上 Hub 就会出现。')
              : null,
          ),
        ),
        h('div', { className: 'cb-members-detail' },
          (runtime && runtime.fork)
            ? h('div', { className: 'cb-banner', style: { alignItems: 'flex-start' } },
              h('div', { className: 'cb-banner-text' },
                '原 Hub 复活了：' + String(runtime.fork.origin || '').slice(0, 6)
                + ' @ ' + (runtime.fork.host || '?') + ':' + (runtime.fork.port || '?')
                + '。两个 Hub 并存，序号可能重复、事件流已分叉 —— 选一边，别两边都写。'),
              h('div', { className: 'cb-banner-actions' },
                h(Btn, {
                  small: true,
                  disabled: Boolean(hubBusy),
                  title: '停掉本机 Hub，改连对方',
                  onClick: () => doHubAction('yield', {
                    address: 'http://' + (runtime.fork.host || '127.0.0.1') + ':' + (runtime.fork.port || 48910),
                  }),
                }, hubBusy === 'yield' ? '切换中…' : '断开我的 Hub，去连它'),
                h(Btn, { small: true, ghost: true, onClick: () => doHubAction('dismiss-fork') }, '忽略'),
              ))
            : (model.hasFork && !ignoredFork
              ? h('div', { className: 'cb-banner' },
                h('div', { className: 'cb-banner-text' }, '事件流里有一条分叉记录（历史）。当前以「当前 Hub」卡片为准。'),
                h('div', { className: 'cb-banner-actions' },
                  h(Btn, { small: true, ghost: true, onClick: () => setIgnoredFork(true) }, '知道了')))
              : null),
          hubOffline
            ? h('div', { className: 'cb-banner' },
              h(Icon, { name: 'warn', size: 12 }),
              h('div', { className: 'cb-banner-text' }, 'Hub 离线：角色是「' + ROLE_LABEL[settings.role] + '」，但还没有收到 Hub 信息。'),
            )
            : null,

          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-card-h' },
              h(Icon, { name: 'hub', size: 13 }),
              h('span', { className: 'cb-grow' }, '当前 Hub'),
              hubRunning
                ? h(Pill, { tone: 'done' }, '本机 Hub 运行中')
                : hubConnected
                  ? h(Pill, { tone: 'done' }, '已连接')
                  : h(Pill, null, settings.role === 'solo' ? '单机' : '未连接'),
            ),
            (hubRunning || hub || hubConnected)
              ? h('div', { style: { marginTop: 2 } },
                h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '地址'),
                  h('span', { className: 'cb-kv-v', title: address }, address || '—')),
                h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '任期 epoch'),
                  h('span', { className: 'cb-kv-v' },
                    String((runtime && runtime.server && runtime.server.epoch) || (hub && hub.epoch) || 0))),
                h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '在线成员'),
                  h('span', { className: 'cb-kv-v' }, String(online))),
                h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '待同步'),
                  h('span', { className: 'cb-kv-v' },
                    String(runtime && Number.isFinite(runtime.pending) ? runtime.pending : 0) + ' 条')),
                runtime && runtime.files
                  ? h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '文件库'),
                    h('span', { className: 'cb-kv-v' },
                      String(runtime.files.count) + ' 个 · ' + fmtSize(runtime.files.bytes)))
                  : null,
              )
              : h(Empty, {
                icon: h(Icon, { name: 'hub', size: 18 }),
                title: '没有 Hub',
                desc: '单机模式下看板只读本机日志。要两台设备协作：一台点「我来当 Hub」，另一台填它的地址加入。',
              }),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
              h(Btn, {
                ghost: true,
                disabled: !address,
                title: address ? '复制 Hub 地址给另一台设备' : '没有 Hub，没东西可邀请',
                onClick: () => copy(address, '邀请'),
              }, h(Icon, { name: 'copy', size: 12 }), '复制邀请'),
              h(Btn, {
                primary: true,
                disabled: hubRunning || hubBusy === 'start' || !onHubAction,
                title: hubRunning ? '本机已经在当 Hub 了' : '在本机起 Hub，端口和口令在设置里',
                onClick: () => doHubAction('start'),
              }, hubBusy === 'start' ? '正在起…' : '我来当 Hub'),
              hubRunning
                ? h(Btn, {
                  danger: true,
                  disabled: hubBusy === 'stop',
                  title: '停掉本机 Hub。已连上来的成员会掉线，事件还在日志里',
                  onClick: () => doHubAction('stop'),
                }, hubBusy === 'stop' ? '正在停…' : '停止 Hub')
                : null,
            ),
            hubRunning ? null : h('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', { className: 'cb-hint', style: { marginBottom: 4 } }, '加入另一台的 Hub'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('input', {
                  className: 'cb-input',
                  placeholder: 'http://192.168.1.5:48910',
                  value: joinAddress,
                  disabled: Boolean(hubBusy),
                  onChange: (e) => setJoinAddress(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') submitJoin(); },
                }),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h('input', {
                    className: 'cb-input',
                    type: 'password',
                    placeholder: '口令（对方设了才填，留空 = 没设）',
                    value: joinCode,
                    maxLength: 64,
                    autoComplete: 'current-password',
                    disabled: Boolean(hubBusy),
                    onChange: (e) => setJoinCode(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') submitJoin(); },
                  }),
                  h(Btn, {
                    small: true,
                    disabled: Boolean(hubBusy) || joinAddress.trim() === '',
                    onClick: submitJoin,
                  }, hubBusy === 'join' ? '连接中…' : '加入'),
                ),
              ),
              h('div', { className: 'cb-hint', style: { marginTop: 4 } },
                '对方设了口令必须填对，错了会当场报「口令不对」；留空只是「对方没设口令」时才连得上。'),
              hubConnected
                ? h(Btn, { small: true, ghost: true, onClick: () => doHubAction('leave') }, '断开连接')
                : null,
            ),
            h('div', { className: 'cb-hint', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              '心跳 15 秒一次，45 秒无响应视为离线。'),
          ),

          h('div', { className: 'cb-card' },
            h('div', { className: 'cb-card-h' }, '我的连接信息'),
            h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '角色'),
              // 显示**运行态**，不是设置里那个值 —— 否则 Hub 明明在跑，这里却写「单机」
              h('span', { className: 'cb-kv-v' },
                runtime && runtime.server
                  ? 'Hub 主机'
                  : (runtime && runtime.client && runtime.client.online
                    ? '成员（已连 Hub）'
                    : ROLE_LABEL[settings.role]))),
            h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '显示名'),
              h('span', { className: 'cb-kv-v' }, settings.selfName || '本机')),
            h('div', { className: 'cb-kv' }, h('span', { className: 'cb-kv-k' }, '事件数'),
              h('span', { className: 'cb-kv-v' }, String(model.total))),
          ),
        ),
      );
    }

    /* ────────────────────────────── 面板 ────────────────────────────── */

    function Panel() {
      ensureCss();
      const [view, setView] = useState('board');
      const [state, setState] = useState({ loading: true, error: null, events: [], total: 0 });
      const [settings, setSettingsState] = useState(SETTINGS_DEFAULTS);
      const [dataDir, setDataDir] = useState('');
      const [toasts, setToasts] = useState([]);
      const [selectedId, setSelectedId] = useState('');
      const [feedOpen, setFeedOpen] = useState(false);
      const [width, setWidth] = useState(820);
      const [filter, setFilter] = useState('all');
      const [showDone, setShowDone] = useState(false);
      const [showArchived, setShowArchived] = useState(false);
      const [creating, setCreating] = useState(false);
      const [menu, setMenu] = useState(null);
      const [hint, setHint] = useState(null);
      const [ready, setReady] = useState(false);
      /** Hub 运行态。null = 老宿主没有这个接口（或还没读到）。 */
      const [hub, setHub] = useState(null);
      /**
       * 宿主包版本（`/collab-board/version`）。
       *   null    = 还没读到
       *   'legacy'= 宿主没有这个路由（< 0.10.6）
       *   {version,...} = 宿主进程实际加载的包版本
       * 客户端常量只能证明「浏览器加载了哪份 bundle」，判不了宿主，所以单开一项。
       */
      const [hostVer, setHostVer] = useState(null);
      /**
       * Hub 现报的成员在线态（`/collab-board/members`）。
       *   null = 没连 Hub / 拉不到 → 界面退回事件流里的旧值（只是会标「连不上」）
       *   { at, map: origin → { online, status, lastSeen } }
       *
       * 为什么不能只靠事件流：`member` 事件只有 join 那一条，之后再也不写 ——
       * 拿它画「在线」等于画「加入那一刻在线」，关机了也不会变。
       */
      const [presence, setPresence] = useState(null);

      const rootRef = useRef(null);
      const settingsRef = useRef(settings);
      const toastSeq = useRef(0);

      useEffect(() => { settingsRef.current = settings; }, [settings]);

      const toast = useCallback((text, tone) => {
        const id = (toastSeq.current += 1);
        setToasts((list) => list.concat([{ id, text, tone: tone || 'info' }]));
        setTimeout(() => {
          setToasts((list) => list.filter((t) => t.id !== id));
        }, tone === 'error' ? 5200 : 3200);
      }, []);

      /** Hub 状态。老宿主没有 `/hub` 路由，失败就留 null，界面按「单机」画。 */
      const refreshHub = useCallback(async () => {
        try {
          const data = await fetchJson('/hub');
          setHub(data && data.ok !== false ? data : null);
        } catch {
          setHub(null);
        }
      }, []);

      /** 成员在线态。没连 Hub 是正常的（单机），不是错误。 */
      const refreshPresence = useCallback(async () => {
        try {
          const data = await fetchJson('/members');
          if (data && data.ok !== false && data.connected && Array.isArray(data.members)) {
            const map = {};
            for (const m of data.members) {
              if (m && typeof m.origin === 'string' && m.origin) map[m.origin] = m;
            }
            setPresence({ at: Date.now(), map });
          } else {
            setPresence(null);
          }
        } catch {
          setPresence(null);
        }
      }, []);

      /** 起 Hub / 停 Hub / 加入 / 断开。失败原样抛，调用方 toast。 */
      const hubAction = useCallback(async (action, body) => {
        const out = await fetchJson('/hub/' + action, {
          method: 'POST',
          body: JSON.stringify(body || {}),
        });
        if (out && out.status) setHub(out.status);
        else await refreshHub();
        return out;
      }, [refreshHub]);

      const refreshState = useCallback(async () => {
        try {
          const data = await fetchJson('/state?since=0');
          setState((prev) => ({
            loading: false,
            error: null,
            events: Array.isArray(data.events) ? data.events : [],
            total: Number.isFinite(Number(data.total)) ? Number(data.total) : 0,
            lastFetch: Date.now(),
            prevTotal: prev.total,
          }));
        } catch (e) {
          setState((prev) => ({ ...prev, loading: false, error: e.message }));
        }
      }, []);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const [s, st] = await Promise.all([fetchJson('/settings'), fetchJson('/state?since=0')]);
            if (!alive) return;
            if (s.settings) setSettingsState(s.settings);
            if (s.dataDir) setDataDir(s.dataDir);
            setState({
              loading: false,
              error: null,
              events: Array.isArray(st.events) ? st.events : [],
              total: Number.isFinite(Number(st.total)) ? Number(st.total) : 0,
            });
            setReady(true);
          } catch (e) {
            if (!alive) return;
            setState({ loading: false, error: e.message, events: [], total: 0 });
          }
          try {
            const h = await fetchJson('/hub');
            if (alive && h && h.ok !== false) setHub(h);
          } catch { /* 老宿主没有 /hub，按单机画 */ }
          try {
            const v = await fetchJson('/version');
            if (alive) setHostVer(v && v.ok !== false ? v : 'legacy');
          } catch { if (alive) setHostVer('legacy'); }
        })();
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        if (!ready) return undefined;
        const ms = Math.max(1000, Number(settings.pollIntervalMs) || 3000);
        // 事件每 pollIntervalMs 拉一次；Hub 状态更慢一点（5 秒），不用跟着事件抖
        const timer = setInterval(() => { refreshState(); }, ms);
        const hubTimer = setInterval(() => { refreshHub(); refreshPresence(); }, Math.max(5000, ms));
        // 进页面先拉一次在线态，别等 5 秒才知道谁真的在线
        refreshPresence();
        return () => { clearInterval(timer); clearInterval(hubTimer); };
      }, [ready, settings.pollIntervalMs, refreshState, refreshHub, refreshPresence]);

      useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver((entries) => {
          const w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
          if (w > 0) setWidth(w);
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      useEffect(() => {
        if (!menu) return undefined;
        const close = () => setMenu(null);
        window.addEventListener('click', close);
        window.addEventListener('scroll', close, true);
        return () => {
          window.removeEventListener('click', close);
          window.removeEventListener('scroll', close, true);
        };
      }, [menu]);

      const model = useMemo(
        () => buildModel(state.events, settings.maxReplay),
        [state.events, settings.maxReplay],
      );

      /* 最新一条系统提示：顶部灰条停留 6 秒，然后收进动态流 */
      const latestNote = model.notes.length ? model.notes[model.notes.length - 1] : null;
      useEffect(() => {
        if (!latestNote) { setHint(null); return undefined; }
        setHint(latestNote);
        const timer = setTimeout(() => setHint(null), 6000);
        return () => clearTimeout(timer);
      }, [latestNote && latestNote.ts, latestNote && latestNote.text]);

      const saveSetting = useCallback(async (key, value) => {
        const prev = settingsRef.current;
        /**
         * hubCode 不能按值去重（0.11.13）。
         *
         * 宿主永远不回传口令原文，前端看到的 `hubCode` 恒为 ''。于是「清除口令」
         * 调 `saveSetting('hubCode', '')` 时，这里判成「没变」直接 return ——
         * PATCH 根本没发出去，界面还显示「已设置」。点了没用就是这个。
         */
        if (key !== 'hubCode' && prev[key] === value) return;
        setSettingsState((s) => ({ ...s, [key]: value }));
        try {
          const res = await fetchJson('/settings', {
            method: 'PATCH',
            body: JSON.stringify({ patch: { [key]: value } }),
          });
          if (res.settings) setSettingsState(res.settings);
        } catch (e) {
          setSettingsState(prev);
          toast('保存失败，已还原：' + e.message, 'error');
        }
      }, [toast]);

      const post = useCallback(async (body) => {
        const res = await postEvent(body);
        await refreshState();
        return res.event;
      }, [refreshState]);

      /**
       * 认领。**不用 fetchJson** —— 它会把 `error` 字段当消息吞掉，
       * 而认领恰恰要区分 `conflict`（别人抢了）/ `blocked`（依赖没完成）/`bad-param`。
       */
      const claimTask = useCallback(async (taskId, opts) => {
        const res = await fetch(apiUrl('/tasks/claim'), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId, ...(opts || {}) }),
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (!res.ok || !data || data.ok === false) {
          const e = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
          e.code = data && data.error;
          e.owner = data && data.owner;
          e.blockedBy = data && data.blockedBy;
          throw e;
        }
        await Promise.all([refreshState(), refreshHub()]);
        return data;
      }, [refreshState, refreshHub]);

      const clearData = useCallback(async () => {
        try {
          await fetchJson('/events', { method: 'DELETE' });
          await refreshState();
          toast('本地数据已清空');
        } catch (e) {
          toast('清空失败：' + e.message, 'error');
        }
      }, [refreshState, toast]);

      const copyText = useCallback(async (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }, []);

      const me = settings.selfName || '本机';
      const narrow = width < WIDE_AT;
      const selectedTask = selectedId ? model.byId.get(selectedId) : null;

      const createTask = useCallback(async (title) => {
        // 不再从共享视图里「取最大 tN + 1」—— 两台机器在同一个轮询窗口里
        // 会数到同一个 N，发出同一个 taskId，后推的那条把前一张卡整条覆盖
        // （R5 真机撞号：两边各建一张 t10，板上只剩后到的那张）。
        // 改成随机短 id：不依赖板上已有卡片，撞号概率可忽略。
        const id = 't-' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
        try {
          await post({
            kind: 'task',
            id,
            taskId: id,
            title,
            status: 'pending',
            priority: 'normal',
          });
          setCreating(false);
          setSelectedId(id);
          toast('已创建 ' + id);
        } catch (e) {
          toast('没创建成功：' + e.message, 'error');
        }
      }, [post, toast]);

      const openTask = useCallback((id) => {
        setSelectedId(id);
        setMenu(null);
      }, []);

      const memberCount = useMemo(() => {
        // 只数真实成员（member 事件）+ 本机自己；消息里出现过的名字不算人 ——
        // 否则「本机」「涟涟」「汐汐（自测）」这些历史发言会把人数撑成 5 位。
        const selfName = settings.selfName || '本机';
        const origins = new Set();
        for (const m of model.members) {
          if (m.name !== selfName) origins.add(m.origin);
        }
        return origins.size + 1;
      }, [model.members, settings.selfName]);

      const roleLabel = hub && hub.server
        ? 'Hub 主机'
        : (hub && hub.client && hub.client.online ? '已连 Hub' : ROLE_MODE[settings.role]);
      const headerSub = state.loading
        ? '读取中…'
        : (roleLabel + ' · ' + model.tasks.length + ' 个任务 · ' + memberCount + ' 位成员');

      const errorView = h('div', { className: 'cb-empty' },
        h('div', { className: 'cb-empty-icon' }, h(Icon, { name: 'warn', size: 18 })),
        h('div', { className: 'cb-empty-title' }, '读不到看板数据'),
        h('div', { className: 'cb-empty-desc' }, state.error || '宿主接口没有响应。'),
        h('div', { style: { marginTop: 4 } },
          h(Btn, { small: true, onClick: refreshState }, '重试')),
      );

      const loadingView = h('div', { style: { padding: '6px 2px', display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'cb-skel', style: { width: '70%' } }),
        h('div', { className: 'cb-skel', style: { width: '92%' } }),
        h('div', { className: 'cb-skel', style: { width: '84%' } }),
        h('div', { className: 'cb-skel', style: { width: '60%' } }),
      );

      const boardView = h('div', {
        className: 'cb-board' + (narrow ? ' cb-narrow' : ''),
        'data-detail': narrow && (selectedId || feedOpen) ? '1' : undefined,
      },
        h('div', { className: 'cb-col-list' },
          h('div', { className: 'cb-toolbar' },
            h('span', { className: 'cb-toolbar-title' }, '任务'),
            h('span', { className: 'cb-grow' }),
            h(Btn, {
              small: true,
              ghost: true,
              onClick: () => { setSelectedId(''); setFeedOpen(true); },
            }, h(Icon, { name: 'chat', size: 12 }), '动态'),
            h(Btn, {
              small: true,
              ghost: true,
              onClick: () => { setCreating(true); setFilter('all'); },
            }, h(Icon, { name: 'plus', size: 12 }), '新建'),
          ),
          settings.showSystemEvents && hint
            ? h('div', {
              className: 'cb-hint',
              style: { padding: '0 4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
              title: hint.text,
            }, '系统 · ' + hint.text)
            : null,
          h(BoardListParts, {
            model,
            settings,
            filter,
            setFilter,
            showDone,
            setShowDone,
            showArchived,
            setShowArchived,
            selectedId,
            onSelect: (id) => { setFeedOpen(false); openTask(id); },
            onMenu: (e, task) => setMenu({ x: e.clientX, y: e.clientY, task }),
            creating,
            setCreating,
            onCreate: createTask,
          }),
        ),
        h('div', { className: 'cb-col-detail' },
          narrow && (selectedId || feedOpen)
            ? h('div', { className: 'cb-toolbar' },
              h(Btn, {
                small: true,
                ghost: true,
                onClick: () => { setSelectedId(''); setFeedOpen(false); },
              }, h(Icon, { name: 'back', size: 12 }), '列表'))
            : null,
          selectedTask
            ? h(TaskDetail, {
              task: selectedTask,
              model,
              settings,
              me,
              toast,
              hub,
              onClaim: claimTask,
              onPost: post,
              onOpenTask: (id) => { setFeedOpen(false); openTask(id); },
            })
            : h(GlobalFeed, {
              model,
              settings,
              me,
              toast,
              onPost: post,
              onOpenTask: (id) => { setFeedOpen(false); openTask(id); },
            }),
        ),
      );

      /**
       * 页面 bundle 和宿主进程的版本对不上 —— 这正是「面板显示新版、实际跑旧版」的样子。
       * 只比明确拿到的版本号：legacy（<0.10.6 没这个路由）不报，免得老宿主满屏警告。
       */
      const verDrift = Boolean(
        hostVer && typeof hostVer === 'object' && hostVer.version && hostVer.version !== VERSION,
      );

      return h('div', { className: 'cb-root', ref: rootRef },
        h('div', { className: 'cb-wrap' },
          h('div', { className: 'cb-head' },
            h('div', { className: 'cb-head-icon' }, h(Icon, { name: 'board', size: 15 })),
            h('div', { className: 'cb-head-text' },
              h('div', { className: 'cb-title' }, '协作看板',
                h('span', {
                  className: 'cb-title-ver' + (verDrift ? ' cb-drift' : ''),
                  title: verDrift
                    ? `页面 bundle 是 ${VERSION}，宿主进程加载的是 ${hostVer.version}。`
                      + '两种可能：页面没刷新（先 F5），或者宿主没重启（文件换了进程没换）。'
                    : 'v/b 是客户端常量（浏览器加载的 bundle）；「宿主」是宿主进程实际加载的包版本，来自 /collab-board/version',
                },
                  'v' + VERSION + ' · b' + BUILD
                  + (hostVer ? ' · 宿主 ' + (typeof hostVer === 'string' ? '<0.10.6' : (hostVer.version || '?')) : '')
                  + (verDrift ? ' ⚠ 版本不一致' : ''))),
              h('div', { className: 'cb-sub' }, headerSub),
            ),
            h('nav', { className: 'cb-seg', role: 'tablist' },
              [['board', '看板'], ['settings', '设置'], ['members', '成员']].map(([id, label]) =>
                h('button', {
                  key: id,
                  type: 'button',
                  className: 'cb-seg-btn',
                  'data-on': view === id ? '' : undefined,
                  onClick: () => setView(id),
                }, label)),
            ),
          ),

          state.loading
            ? loadingView
            : state.error && state.events.length === 0
              ? errorView
              : h(Fragment, null,
                state.error
                  ? h('div', { className: 'cb-banner', 'data-tone': 'error' },
                    h(Icon, { name: 'warn', size: 12 }),
                    h('div', { className: 'cb-banner-text' }, '刷新失败，看到的是上次的数据：' + state.error),
                    h('div', { className: 'cb-banner-actions' },
                      h(Btn, { small: true, onClick: refreshState }, '重试')),
                  )
                  : null,
                /**
                 * 版本不一致：**必须给一个一键动作**。
                 * 原来只有标题旁标黄 + tooltip —— 知道不一致，却还得自己想「那我该干嘛」。
                 */
                verDrift
                  ? h('div', { className: 'cb-banner', 'data-tone': 'error' },
                    h(Icon, { name: 'warn', size: 12 }),
                    h('div', { className: 'cb-banner-text' },
                      `版本不一致：页面 bundle 是 ${VERSION}，宿主进程加载的是 ${hostVer.version}。`
                      + '先点右边重新加载；还不对就是宿主没重启（文件换了、进程没换）。'),
                    h('div', { className: 'cb-banner-actions' },
                      h(Btn, {
                        small: true,
                        onClick: () => { try { window.location.reload(); } catch { /* 老环境 */ } },
                      }, '重新加载页面')),
                  )
                  : null,
                hub && hub.systemBroken
                  ? h('div', { className: 'cb-banner', 'data-tone': 'error' },
                    h(Icon, { name: 'warn', size: 12 }),
                    h('div', { className: 'cb-banner-text' },
                      '系统写入熔断了：Hub 写不进系统事件，租约和成员广播会停。'),
                    h('div', { className: 'cb-banner-actions' },
                      h(Btn, {
                        small: true,
                        onClick: async () => {
                          try {
                            await fetchJson('/system/recover', { method: 'POST', body: '{}' });
                            await refreshHub();
                            toast('已恢复');
                          } catch (e) {
                            toast('恢复失败：' + e.message, 'error');
                          }
                        },
                      }, '恢复')),
                  )
                  : null,
                h('div', { className: 'cb-body' },
                view === 'board' ? boardView : null,
                view === 'settings'
                  ? h(SettingsView, {
                    settings,
                    saveSetting,
                    toast,
                    dataDir,
                    onClearData: clearData,
                  })
                  : null,
                view === 'members'
                  ? h(MembersView, {
                    model,
                    settings,
                    me,
                    toast,
                    presence,
                    onCopy: copyText,
                    runtime: hub,
                    onHubAction: hubAction,
                    onHideMember: (csv) => saveSetting('hiddenMembers', csv),
                  })
                  : null,
              ),
              ),

          h('div', { className: 'cb-foot' },
            h('span', null, (state.total || 0) + ' 条事件'),
            h('span', null, '·'),
            h('span', null, state.lastFetch ? '刚刚更新' : '本机'),
            h('span', { className: 'cb-grow' }),
            state.error ? h('span', { style: { color: 'var(--dsw-alias-label-error)' } }, '连接异常') : null,
            h('span', null, 'v' + VERSION + ' · b' + BUILD),
          ),
        ),

        menu
          ? h('div', {
            className: 'cb-menu',
            style: {
              left: Math.min(menu.x, Math.max(8, window.innerWidth - 150)) + 'px',
              top: Math.min(menu.y, Math.max(8, window.innerHeight - 160)) + 'px',
            },
            onClick: (e) => e.stopPropagation(),
          },
            h('button', { type: 'button', onClick: () => { openTask(menu.task.taskId); } }, '查看详情'),
            h('button', {
              type: 'button',
              onClick: async () => {
                const task = menu.task;
                setMenu(null);
                try {
                  await post({
                    kind: 'task',
                    id: task.taskId,
                    taskId: task.taskId,
                    title: task.title,
                    owner: task.owner,
                    status: task.status,
                    detail: task.detail,
                    dependsOn: task.dependsOn,
                    requiredCapabilities: task.requiredCapabilities,
                    priority: task.priority,
                    tags: task.tags,
                    dueAt: task.dueAt || undefined,
                    archived: !task.archived,
                  });
                  toast(task.archived ? '已取消归档' : '已归档');
                } catch (e) {
                  toast('归档失败：' + e.message, 'error');
                }
              },
            }, menu.task.archived ? '取消归档' : '归档'),
            h('button', {
              type: 'button',
              style: { color: 'var(--dsw-alias-label-error)' },
              onClick: async () => {
                const task = menu.task;
                setMenu(null);
                if (!window.confirm('删掉这张卡？标题、描述、标签会被清空，日志里只留一个壳（跨机同步，不能撤销）。')) return;
                try {
                  const out = await fetchJson('/tasks/delete', {
                    method: 'POST',
                    body: JSON.stringify({ taskId: task.taskId }),
                  });
                  if (out && out.ok === false) throw new Error(out.error || '删除失败');
                  toast('已删除 ' + task.taskId);
                  await refreshState();
                } catch (e) {
                  toast('删除失败：' + e.message, 'error');
                }
              },
            }, '删除'),
            h('button', {
              type: 'button',
              onClick: async () => {
                const id = menu.task.taskId;
                setMenu(null);
                try { await copyText(id); toast('已复制 ' + id); } catch (e) { toast('复制失败', 'error'); }
              },
            }, '复制 ID'),
          )
          : null,

        h('div', { className: 'cb-toasts' },
          toasts.map((t) => h('div', { key: t.id, className: 'cb-toast', 'data-tone': t.tone }, t.text)),
        ),
      );
    }

    /** BoardList 拆出来只是为了 Panel 里少一层缩进，逻辑全在 BoardList。 */
    function BoardListParts(props) {
      return h(BoardList, props);
    }

    /** 一块面板挂掉不该整页空白 —— 和刷抖音那页同一个教训。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err };
      }
      render() {
        if (this.state.err) {
          return h('div', { className: 'cb-root' },
            h('div', { className: 'cb-wrap' },
              h('div', { className: 'cb-empty' },
                h('div', { className: 'cb-empty-icon' }, h(Icon, { name: 'warn', size: 18 })),
                h('div', { className: 'cb-empty-title' }, '这页出错了'),
                h('div', { className: 'cb-empty-desc' }, String(this.state.err && this.state.err.message ? this.state.err.message : this.state.err)),
                h('div', { style: { marginTop: 4 } },
                  h(Btn, { small: true, onClick: () => this.setState({ err: null }) }, '重试')),
              ),
            ),
          );
        }
        return this.props.children;
      }
    }

    function SafePanel() {
      return h(Boundary, null, h(Panel));
    }

    /** 侧栏图标。owner 传 `{ size, active }`，是 SidebarPanelIconOwnerProps。 */
    function Icon_Sidebar(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { opacity: active ? 1 : 0.78 },
      },
        h('path', { d: 'M9.5 3.5a6 6 0 1 0 0 12H11l2.5 2v-2.4a6 6 0 0 0-4-11.6z' }),
        h('path', { d: 'M15.5 9.5a4.5 4.5 0 0 1 3 7.9v2.1l-2.2-1.6a4.5 4.5 0 0 1-2.8-1.3' }),
      );
    }

    function apply(ctx) {
      // 侧栏格子。用**自己的 id**，复用别人的会顶掉人家的格子。
      // order 50：排在常用面板之后。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => '协作看板' },
          Icon_Sidebar,
        ),
      );

      // 主面板。key 必须与侧栏 id 一致 —— 侧栏按钮靠这个 key 找面板。
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, SafePanel),
      );
    }

    return { name: 'dsh-collab-board', inject: ['slots'], apply };
  },
});
