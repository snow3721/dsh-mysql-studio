// dsh-mysql-studio — browser half.
//
// A DataGrip-shaped MySQL workbench that lives in DSH's right Sidebar.
//
// Sidebar integration auto-adapts, because two registration surfaces exist and
// they are not interchangeable:
//
//   * `ctx.betterSidebar` (dsh-better-sidebar) — registering here hands the
//     descriptor to that plugin, which republishes it as a NATIVE DSH tab type
//     (`dsh-better-sidebar:<id>`) and gives it a guide entry plus a side-card
//     enable switch for free.
//   * `ctx.sidebarRightTabs` (DSH core) — the raw native registry, used when
//     dsh-better-sidebar is not installed.
//
// Everything else in this file is the workbench itself, and it depends on
// neither: it talks to the host half over one JSON endpoint.
//
// This file is a hand-authored browser bundle in DSH's module-loader format
// (`window.__ModuleLoader__.load`), so no build step stands between the source
// and what the page runs. React and its JSX runtime are baseline modules.

window.__ModuleLoader__.load({
  id: "dsh-mysql-studio",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;

    // ── constants ─────────────────────────────────────────────────────────

    const API_BASE = "/mysql-studio/api";
    /** The page kind this plugin owns: the tab discriminator `openTab` names. */
    const KIND = "mysql-studio";
    /** This plugin's own native-registry identity (dsh-better-sidebar uses its own prefix). */
    const NATIVE_ID = "dsh-mysql-studio:studio";
    const PAGE_SIZE = 100;

    // ── host API ──────────────────────────────────────────────────────────

    /**
     * One call to the host half. The host answers `{ ok, result }` or
     * `{ ok: false, error }`, so a failure carries the database's own message
     * rather than a bare status code.
     */
    async function callApi(method, params) {
      let response;
      try {
        response = await fetch(API_BASE + "/" + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params === undefined ? {} : params),
        });
      } catch (error) {
        throw new Error(
          "无法连接插件后端（/mysql-studio/api）。确认 dsh-mysql-studio 的 Host 半已随 dsh web 一起加载。"
          + (error instanceof Error ? " " + error.message : ""),
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("后端返回了非 JSON 响应（HTTP " + response.status + "）");
      }
      if (payload === null || payload.ok !== true) {
        throw new Error((payload && payload.error && payload.error.message) || "HTTP " + response.status);
      }
      return payload.result;
    }

    // ── cell formatting ───────────────────────────────────────────────────

    function isBinaryType(type) {
      return typeof type === "string" && /blob|binary/i.test(type);
    }

    /** Describe a base64 cell as a byte count plus a short hex preview. */
    function binaryInfo(base64) {
      try {
        const raw = atob(base64);
        let hex = "";
        for (let i = 0; i < Math.min(raw.length, 16); i += 1) {
          hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
        }
        return { bytes: raw.length, hex: raw.length > 16 ? hex + "…" : hex };
      } catch {
        return { bytes: null, hex: "" };
      }
    }

    /**
     * Render one cell. The column's declared type decides how a scalar reads —
     * which is why the host can send every cell as a scalar.
     */
    function formatCell(value, column) {
      if (value === null || value === undefined) return { text: "NULL", kind: "null" };
      if (typeof value === "boolean") return { text: value ? "true" : "false", kind: "bool" };
      if (isBinaryType(column && column.type)) {
        const info = binaryInfo(String(value));
        return {
          text: info.bytes === null ? "<binary>" : "<BINARY " + info.bytes + " bytes>",
          title: info.hex ? "0x" + info.hex : undefined,
          kind: "binary",
        };
      }
      if (typeof value === "object") return { text: JSON.stringify(value), kind: "json" };
      return { text: String(value), kind: "text" };
    }

    /** Back-quote an identifier, mirroring the host. */
    function quoteId(name) {
      return "`" + String(name).replace(/`/g, "``") + "`";
    }

    /** One cell as a MySQL literal for INSERT export. */
    function sqlLiteral(value, column) {
      if (value === null || value === undefined) return "NULL";
      const type = String((column && (column.type || column.columnType || column.dataType)) || "");
      if (/blob|binary/i.test(type)) {
        try {
          const raw = atob(String(value));
          let hex = "";
          for (let i = 0; i < raw.length; i += 1) hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
          return "X'" + hex + "'";
        } catch {
          return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
        }
      }
      if (typeof value === "boolean") return value ? "1" : "0";
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (/int|decimal|float|double|numeric|bit|year/i.test(type) && value !== "" && Number.isFinite(Number(value))) {
        return String(value);
      }
      return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
    }

    /**
     * Turn the current result grid into INSERT statements.
     * Lives in the browser so a large page never has to round-trip to export.
     */
    function formatInsertSql(request) {
      const columns = request.columns || [];
      const rows = request.rows || [];
      if (columns.length === 0) throw new Error("没有可导出的列");
      if (rows.length === 0) throw new Error("没有可导出的行");
      const table = String(request.table || "").trim();
      const database = String(request.database || "").trim();
      const target = table !== ""
        ? (database !== "" ? quoteId(database) + "." + quoteId(table) : quoteId(table))
        : "`export`";
      const names = columns.map(column => quoteId(column.name));
      const values = rows.map(row => "(" + row.map((cell, index) => sqlLiteral(cell, columns[index])).join(", ") + ")");
      const parts = [];
      for (let i = 0; i < values.length; i += 100) {
        parts.push("INSERT INTO " + target + " (" + names.join(", ") + ") VALUES\n  " + values.slice(i, i + 100).join(",\n  ") + ";");
      }
      return parts.join("\n\n") + "\n";
    }

    /** Trigger a text-file download in the browser. */
    function downloadText(filename, text) {
      if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        throw new Error("当前环境无法下载文件");
      }
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }

    const COLUMN_TYPES = [
      "INT", "BIGINT", "TINYINT", "VARCHAR(255)", "VARCHAR(64)", "CHAR(32)",
      "TEXT", "LONGTEXT", "DATETIME", "DATE", "TIMESTAMP", "DECIMAL(10,2)",
      "FLOAT", "DOUBLE", "JSON", "BOOLEAN",
    ];

    /** A compact number for a table's estimated row count. */
    function formatCount(value) {
      if (value === null || value === undefined) return "?";
      if (value >= 1000000) return (value / 1000000).toFixed(1) + "M";
      if (value >= 1000) return (value / 1000).toFixed(1) + "k";
      return String(value);
    }

    // ── editing model ─────────────────────────────────────────────────────

    /** Whether a submitted cell equals the loaded one. Mirrors the host's no-op rule. */
    function sameCell(submitted, loaded) {
      if (submitted === null || submitted === undefined) return loaded === null || loaded === undefined;
      if (loaded === null || loaded === undefined) return false;
      return String(submitted) === String(loaded);
    }

    /**
     * Why a column cannot be edited here, or `null` when it can.
     *
     * Read from `information_schema` metadata (via `catalog.columns`), not from
     * the result-set field type: the declared type is what tells a `varbinary`
     * from a `varchar`, and the host refuses exactly this same set.
     */
    function readOnlyReason(meta) {
      if (meta === undefined) return "缺少列元数据";
      if (/blob|binary/i.test(meta.columnType || "")) return "二进制列";
      if (/GENERATED/i.test(meta.extra || "")) return "生成列";
      return null;
    }

    /** One loaded row as a column-name → value object. */
    function rowObject(page, rowIndex) {
      const object = {};
      page.columns.forEach((column, index) => {
        object[column.name] = page.rows[rowIndex][index];
      });
      return object;
    }

    /** One loaded row's identity: its primary-key columns and their values. */
    function rowKeyOf(page, rowIndex) {
      const row = rowObject(page, rowIndex);
      const key = {};
      for (const name of page.primaryKey) key[name] = row[name];
      return key;
    }

    /**
     * Translate the editor's local state into the host's mutation shape.
     *
     * The original row and the key travel with every mutation because the host
     * needs them to build a WHERE clause that can detect a lost update — the
     * browser cannot decide that on its own.
     */
    function buildMutations(page, edits, deletions, inserts) {
      const mutations = [];
      for (const rowIndex of Object.keys(edits).map(Number).sort((a, b) => a - b)) {
        const set = edits[rowIndex];
        if (deletions[rowIndex] === true) continue;
        if (Object.keys(set).length === 0) continue;
        mutations.push({
          kind: "update",
          key: rowKeyOf(page, rowIndex),
          set: { ...set },
          original: rowObject(page, rowIndex),
        });
      }
      for (const rowIndex of Object.keys(deletions).map(Number).sort((a, b) => a - b)) {
        if (deletions[rowIndex] !== true) continue;
        mutations.push({
          kind: "delete",
          key: rowKeyOf(page, rowIndex),
          original: rowObject(page, rowIndex),
        });
      }
      for (const values of inserts) mutations.push({ kind: "insert", values: { ...values } });
      return mutations;
    }

    /**
     * How many distinct rows the pending state touches, for the pending bar.
     *
     * A row that is both edited and marked for deletion counts ONCE, as the
     * deletion: the edit is subsumed by the delete, and reporting two rows for
     * one row's worth of intent would be a lie the reader can check.
     */
    function pendingRowCount(edits, deletions, inserts) {
      let count = inserts.length;
      const counted = new Set();
      for (const rowIndex of Object.keys(deletions)) {
        if (deletions[rowIndex] === true) {
          counted.add(rowIndex);
          count += 1;
        }
      }
      for (const rowIndex of Object.keys(edits)) {
        if (counted.has(rowIndex)) continue;
        if (Object.keys(edits[rowIndex]).length > 0) {
          counted.add(rowIndex);
          count += 1;
        }
      }
      return count;
    }

    /** How many individual cells are pending; a deleted row costs its whole width. */
    function pendingCellCount(page, edits, deletions, inserts) {
      let count = 0;
      for (const values of inserts) count += Object.keys(values).length;
      const deleted = new Set();
      for (const rowIndex of Object.keys(deletions)) {
        if (deletions[rowIndex] === true) {
          deleted.add(rowIndex);
          count += page.columns.length;
        }
      }
      for (const rowIndex of Object.keys(edits)) {
        if (deleted.has(rowIndex)) continue;
        count += Object.keys(edits[rowIndex]).length;
      }
      return count;
    }

    // ── styles ────────────────────────────────────────────────────────────

    const CSS = [
      ".mst-root{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--dsw-font-family,inherit);font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);}",
      ".mst-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap;}",
      ".mst-title{font-weight:600;font-size:12px;letter-spacing:.02em;display:flex;align-items:center;gap:5px;}",
      ".mst-spacer{flex:1 1 auto;}",
      ".mst-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;}",
      ".mst-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}",
      ".mst-btn:disabled{opacity:.45;cursor:not-allowed;}",
      ".mst-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}",
      ".mst-btn.link{border-color:transparent;padding:2px 4px;font-size:11px;color:var(--dsw-alias-label-secondary);}",
      ".mst-select,.mst-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:3px 6px;min-width:0;}",
      ".mst-input{width:100%;}",
      ".mst-body{display:flex;flex:1 1 auto;min-height:0;}",
      ".mst-tree{width:210px;flex:0 0 auto;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:4px 0;}",
      ".mst-main{flex:1 1 auto;min-width:0;overflow:auto;display:flex;flex-direction:column;}",
      ".mst-group{padding:6px 8px 2px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);}",
      ".mst-row{display:flex;align-items:center;gap:5px;padding:3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".mst-row:hover{background:var(--dsw-alias-bg-layer-2);}",
      ".mst-row.active{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);}",
      ".mst-row .mst-count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:10px;flex:0 0 auto;}",
      ".mst-row.db{padding-left:14px;}",
      ".mst-row.table{padding-left:28px;}",
      ".mst-caret{width:9px;flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:9px;}",
      ".mst-empty{padding:16px;color:var(--dsw-alias-label-secondary);line-height:1.7;}",
      ".mst-error{margin:6px 8px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);word-break:break-word;flex:0 0 auto;}",
      ".mst-ok{color:var(--dsw-alias-state-success-primary);}",
      ".mst-tabs{display:flex;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;align-items:center;}",
      ".mst-tab{padding:4px 10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;border-bottom:2px solid transparent;}",
      ".mst-tab.active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);}",
      ".mst-gridwrap{flex:1 1 auto;min-height:0;overflow:auto;}",
      "table.mst-grid{border-collapse:separate;border-spacing:0;font-size:11px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);width:max-content;min-width:100%;}",
      ".mst-grid th{position:sticky;top:0;z-index:2;text-align:left;padding:4px 8px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);border-right:1px solid var(--dsw-alias-border-l2);white-space:nowrap;font-weight:600;}",
      ".mst-grid th .mst-coltype{display:block;font-weight:400;font-size:9px;color:var(--dsw-alias-label-secondary);}",
      ".mst-grid td{padding:3px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;}",
      ".mst-grid tr:hover td{background:var(--dsw-alias-bg-layer-1);}",
      ".mst-grid td.num,.mst-grid td.bool{text-align:right;}",
      ".mst-grid td.null{color:var(--dsw-alias-label-secondary);font-style:italic;}",
      ".mst-grid td.binary{color:var(--dsw-alias-state-warn-primary);}",
      ".mst-grid .mst-rownum{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);text-align:right;font-size:10px;user-select:none;}",
      ".mst-grid th.mst-rownum{z-index:3;}",
      ".mst-foot{display:flex;align-items:center;gap:8px;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;flex:0 0 auto;flex-wrap:wrap;}",
      ".mst-form{padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto;}",
      ".mst-field{display:flex;flex-direction:column;gap:3px;}",
      ".mst-field label{font-size:10px;color:var(--dsw-alias-label-secondary);}",
      ".mst-fieldrow{display:flex;gap:8px;}",
      ".mst-fieldrow>*{flex:1 1 0;min-width:0;}",
      ".mst-hint{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.6;}",
      ".mst-modal{position:absolute;inset:0;z-index:20;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:12px;}",
      ".mst-modal.front{z-index:21;}",
      ".mst-card{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;width:100%;max-width:460px;display:flex;flex-direction:column;max-height:100%;box-shadow:0 8px 30px rgba(0,0,0,.28);}",
      ".mst-card.wide{max-width:760px;}",
      ".mst-card-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;}",
      ".mst-card-body{overflow:auto;flex:1 1 auto;min-height:0;}",
      ".mst-card-foot{display:flex;gap:6px;justify-content:flex-end;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);}",
      ".mst-textarea{width:100%;min-height:64px;resize:vertical;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;padding:5px 6px;}",
      ".mst-sql{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;padding:8px;gap:6px;}",
      ".mst-sql textarea{min-height:90px;flex:0 0 auto;}",
      ".mst-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px;}",
      ".mst-kv dt{color:var(--dsw-alias-label-secondary);}",
      ".mst-kv dd{margin:0;word-break:break-all;}",
      ".mst-badge{display:inline-block;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:9px;color:var(--dsw-alias-label-secondary);}",
      ".mst-pad{padding:10px;display:flex;flex-direction:column;gap:10px;}",
      /* ── editing ──────────────────────────────────────────────────────── */
      ".mst-grid td.editable{cursor:text;}",
      ".mst-grid td.dirty{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 24%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);}",
      ".mst-grid tr.deleted td{opacity:.4;text-decoration:line-through;}",
      ".mst-grid tr.draft td{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);}",
      ".mst-cell-edit{width:100%;min-width:90px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-brand-primary);border-radius:3px;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:1px 3px;}",
      ".mst-cell-wrap{display:flex;align-items:center;gap:4px;}",
      ".mst-nullbtn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:3px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:9px;padding:0 3px;cursor:pointer;line-height:15px;}",
      ".mst-nullbtn:hover{color:var(--dsw-alias-label-primary);}",
      ".mst-delbtn{border:1px solid transparent;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:0 4px;cursor:pointer;}",
      ".mst-delbtn:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}",
      ".mst-pending{display:flex;align-items:center;gap:8px;padding:5px 8px;flex:0 0 auto;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);}",
      ".mst-pending .mst-strong{font-weight:600;}",
      ".mst-sqlpreview{white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;margin:0;max-height:320px;overflow:auto;}",
      ".mst-note{padding:4px 8px;font-size:10px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}",
      ".mst-colrow{display:grid;grid-template-columns:minmax(80px,1.2fr) minmax(110px,1.4fr) auto auto auto auto;gap:4px;align-items:center;}",
      ".mst-colrow .mst-hint{font-size:10px;}",
      ".mst-check{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
    ].join("\n");

    /** Install the stylesheet once per page, tagged so a reload cannot double it. */
    function installStyles() {
      const marker = "style[data-plugin-css='dsh-mysql-studio/studio.css']";
      if (document.querySelector(marker) !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-mysql-studio";
      tag.dataset.pluginCss = "dsh-mysql-studio/studio.css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ── small components ──────────────────────────────────────────────────

    /** The workbench's own database glyph, so the tab carries no icon dependency. */
    function DatabaseIcon(props) {
      const size = props && props.size ? props.size : 14;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("ellipse", { cx: 8, cy: 3.6, rx: 5, ry: 2.1, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", {
          d: "M3 3.6v8.8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V3.6",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
        }),
        h("path", { d: "M3 8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1", stroke: "currentColor", strokeWidth: 1.3 }),
      );
    }

    /** The result grid, shared by the table view and the SQL console. */
    function Grid(props) {
      const columns = props.columns || [];
      const rows = props.rows || [];
      const offset = props.offset || 0;
      const numeric = column => /int|decimal|float|double|numeric|bit|year/i.test(column.type || "");

      if (columns.length === 0) {
        return h("div", { className: "mst-empty" }, "没有结果集。");
      }
      const head = h(
        "tr",
        null,
        h("th", { className: "mst-rownum", key: "__n" }, "#"),
        columns.map((column, index) =>
          h(
            "th",
            { key: index, title: column.name + "  " + (column.type || "") },
            column.name,
            h("span", { className: "mst-coltype" }, column.type || ""),
          ),
        ),
      );
      const body = rows.map((row, rowIndex) =>
        h(
          "tr",
          { key: rowIndex },
          h("td", { className: "mst-rownum" }, String(offset + rowIndex + 1)),
          row.map((value, cellIndex) => {
            const column = columns[cellIndex] || {};
            const cell = formatCell(value, column);
            const classes = [cell.kind];
            if (cell.kind === "text" && numeric(column)) classes.push("num");
            return h(
              "td",
              { key: cellIndex, className: classes.join(" "), title: cell.title || cell.text },
              cell.text,
            );
          }),
        ),
      );
      return h(
        "div",
        { className: "mst-gridwrap" },
        h("table", { className: "mst-grid" }, h("thead", null, head), h("tbody", null, body)),
      );
    }

    /** The table's column list: the structure view. */
    function ColumnsView(props) {
      const columns = props.columns || [];
      if (columns.length === 0) return h("div", { className: "mst-empty" }, "没有列信息。");
      const rows = columns.map((column, index) =>
        h(
          "tr",
          { key: index },
          h("td", { className: "mst-rownum" }, String(index + 1)),
          h("td", null, column.name),
          h("td", null, column.columnType || ""),
          h("td", null, column.nullable ? "YES" : "NO"),
          h("td", null, column.columnKey || ""),
          h("td", null, column.columnDefault === null ? "NULL" : column.columnDefault),
          h("td", null, column.extra || ""),
          h("td", { title: column.comment || "" }, column.comment || ""),
        ),
      );
      return h(
        "div",
        { className: "mst-gridwrap" },
        h(
          "table",
          { className: "mst-grid" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { className: "mst-rownum" }, "#"),
              h("th", null, "列名"),
              h("th", null, "类型"),
              h("th", null, "可空"),
              h("th", null, "键"),
              h("th", null, "默认"),
              h("th", null, "Extra"),
              h("th", null, "注释"),
            ),
          ),
          h("tbody", null, rows),
        ),
      );
    }

    // ── the editable data grid ────────────────────────────────────────────

    /**
     * The table's rows, with in-place cell editing, row deletion, and one
     * pending "new row" draft.
     *
     * Only the *displayed* page is editable, and every committed cell edit is
     * lifted into the parent's pending state — nothing is sent anywhere until the
     * reader presses 提交, which is what makes the confirmation preview and the
     * discard button mean something.
     *
     * The in-progress text of the cell being edited stays local to this
     * component: it is not a change until it is committed, and mixing it into the
     * parent's state would make 放弃 look like it did nothing.
     */
    function EditableGrid(props) {
      const { page, metaByName, edits, deletions, inserts, draft, canEdit } = props;
      // { row, column } of the cell whose input is open, or null.
      const [openCell, setOpenCell] = useState(null);
      const [openText, setOpenText] = useState("");

      const editColumns = page.columns.filter(column => readOnlyReason(metaByName.get(column.name)) === null);

      const beginEdit = (rowIndex, column) => {
        if (!canEdit) return;
        if (readOnlyReason(metaByName.get(column.name)) !== null) return;
        const row = edits[rowIndex];
        const pending = row !== undefined && Object.prototype.hasOwnProperty.call(row, column.name);
        const loaded = page.rows[rowIndex][page.columns.indexOf(column)];
        setOpenCell({ row: rowIndex, column: column.name });
        setOpenText(pending ? (row[column.name] === null ? "" : String(row[column.name])) : loaded === null ? "" : String(loaded));
      };

      const finishEdit = value => {
        if (openCell === null) return;
        props.onEdit(openCell.row, openCell.column, value);
        setOpenCell(null);
      };

      const onInputKeyDown = event => {
        if (event.key === "Enter") {
          event.preventDefault();
          finishEdit(openText);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setOpenCell(null);
        }
      };

      const draftColumn = (column) => {
        const key = column.name;
        const value = Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : "";
        return h("input", {
          key,
          className: "mst-cell-edit",
          value: value === null ? "" : String(value),
          placeholder: column.type || "",
          spellCheck: false,
          onChange: event => props.onDraftCell(key, event.target.value),
        });
      };

      const head = h(
        "tr",
        null,
        h("th", { className: "mst-rownum", key: "__n" }, "#"),
        page.columns.map((column, index) => {
          const reason = readOnlyReason(metaByName.get(column.name));
          return h(
            "th",
            { key: index, title: column.name + "  " + (column.type || "") + (reason === null ? "" : "  · 只读：" + reason) },
            column.name,
            h("span", { className: "mst-coltype" }, (column.type || "") + (reason === null ? "" : " · 只读")),
          );
        }),
        h("th", { key: "__ops" }, ""),
      );

      const numeric = column => /int|decimal|float|double|numeric|bit|year/i.test((column && column.type) || "");

      const dataRows = page.rows.map((row, rowIndex) => {
        const deleted = deletions[rowIndex] === true;
        const cells = row.map((value, cellIndex) => {
          const column = page.columns[cellIndex] || {};
          const rowEdits = edits[rowIndex];
          const dirty = rowEdits !== undefined && Object.prototype.hasOwnProperty.call(rowEdits, column.name);
          const reason = readOnlyReason(metaByName.get(column.name));
          const open = openCell !== null && openCell.row === rowIndex && openCell.column === column.name;

          if (open) {
            return h(
              "td",
              { key: cellIndex, className: "dirty" },
              h(
                "div",
                { className: "mst-cell-wrap" },
                h("input", {
                  className: "mst-cell-edit",
                  autoFocus: true,
                  value: openText,
                  spellCheck: false,
                  onChange: event => setOpenText(event.target.value),
                  onKeyDown: onInputKeyDown,
                  // Blur commits, so clicking another cell keeps the edit. The
                  // NULL button suppresses the blur first, or it could never fire.
                  onBlur: () => finishEdit(openText),
                }),
                h("button", {
                  className: "mst-nullbtn",
                  type: "button",
                  title: "置为 NULL",
                  onMouseDown: event => event.preventDefault(),
                  onClick: () => finishEdit(null),
                }, "∅"),
              ),
            );
          }

          const shown = dirty ? { text: rowEdits[column.name] === null ? "NULL" : String(rowEdits[column.name]), kind: rowEdits[column.name] === null ? "null" : "text" } : formatCell(value, column);
          const classes = [shown.kind];
          if (shown.kind === "text" && numeric(column)) classes.push("num");
          if (dirty) classes.push("dirty");
          else if (canEdit && reason === null) classes.push("editable");
          return h(
            "td",
            {
              key: cellIndex,
              className: classes.join(" "),
              title: shown.title || (reason === null ? "双击编辑" : "只读：" + reason),
              onDoubleClick: () => beginEdit(rowIndex, column),
            },
            shown.text,
          );
        });

        return h(
          "tr",
          { key: rowIndex, className: deleted ? "deleted" : undefined },
          h("td", { className: "mst-rownum" }, String((props.offset || 0) + rowIndex + 1)),
          cells,
          h(
            "td",
            null,
            deleted
              ? h("button", {
                className: "mst-delbtn",
                type: "button",
                title: "撤销删除这一行",
                onClick: () => props.onRestoreRow(rowIndex),
              }, "↺")
              : h("button", {
                className: "mst-delbtn",
                type: "button",
                title: canEdit ? "删除这一行（提交后生效）" : "该表无主键，不能删除",
                disabled: !canEdit,
                onClick: () => props.onDeleteRow(rowIndex),
              }, "✕"),
          ),
        );
      });

      const draftRow = draft === null ? null : h(
        "tr",
        { className: "draft" },
        h("td", { className: "mst-rownum" }, "新"),
        page.columns.map((column, index) => {
          const reason = readOnlyReason(metaByName.get(column.name));
          if (reason !== null) return h("td", { key: index, className: "null" }, "—");
          return h("td", { key: index }, draftColumn(column));
        }),
        h(
          "td",
          null,
          h("button", { className: "mst-btn", type: "button", onClick: props.onDraftConfirm }, "加入"),
        ),
      );

      return h(
        "div",
        { className: "mst-gridwrap" },
        h(
          "table",
          { className: "mst-grid" },
          h("thead", null, head),
          h("tbody", null, draftRow, dataRows),
        ),
        inserts.length > 0
          ? h(
            "div",
            { className: "mst-note" },
            "待新增 " + inserts.length + " 行：" + inserts.map(values => Object.entries(values).map(([k, v]) => k + "=" + (v === null ? "NULL" : v)).join(", ")).join(" | "),
          )
          : null,
        canEdit
          ? h("div", { className: "mst-note" }, "双击单元格编辑 · Enter 提交该格 · Esc 取消 · 留空并点 ∅ 置为 NULL" + (editColumns.length === page.columns.length ? "" : " · 灰字列只读"))
          : h("div", { className: "mst-note" }, "该表没有主键，无法安全定位单行，因此只读。"),
      );
    }

    /** A labelled field: the label, the control, and an optional hint line. */
    function Field(props) {
      return h(
        "div",
        { className: "mst-field" },
        h("label", null, props.label),
        props.children,
        props.hint ? h("div", { className: "mst-hint" }, props.hint) : null,
      );
    }

    /** Create-database dialog: form is the main path, advanced SQL is the escape hatch. */
    function CreateDatabaseDialog(props) {
      const [tab, setTab] = useState("form");
      const [name, setName] = useState("");
      const [charset, setCharset] = useState("utf8mb4");
      const [collation, setCollation] = useState("");
      const [advanced, setAdvanced] = useState("CREATE DATABASE `new_db` CHARACTER SET `utf8mb4`;");
      const [error, setError] = useState("");

      const onSubmit = () => {
        setError("");
        try {
          if (tab === "sql") {
            if (advanced.trim() === "") throw new Error("SQL 不能为空");
            props.onSubmit({ sql: advanced });
            return;
          }
          if (name.trim() === "") throw new Error("请填写库名");
          props.onSubmit({ name: name.trim(), charset: charset.trim(), collation: collation.trim() });
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      };

      return h(
        "div",
        { className: "mst-modal", onMouseDown: event => { if (event.target === event.currentTarget) props.onCancel(); } },
        h(
          "div",
          { className: "mst-card" },
          h(
            "div",
            { className: "mst-card-head" },
            "新建库",
            h("span", { className: "mst-spacer" }),
            h("button", { className: "mst-btn link", type: "button", onClick: props.onCancel }, "✕"),
          ),
          h(
            "div",
            { className: "mst-tabs" },
            h("button", { className: "mst-tab" + (tab === "form" ? " active" : ""), type: "button", onClick: () => setTab("form") }, "表单"),
            h("button", { className: "mst-tab" + (tab === "sql" ? " active" : ""), type: "button", onClick: () => setTab("sql") }, "高级 SQL"),
          ),
          h(
            "div",
            { className: "mst-card-body" },
            tab === "form"
              ? h(
                "div",
                { className: "mst-form" },
                h(Field, { label: "库名" }, h("input", {
                  className: "mst-input",
                  value: name,
                  autoFocus: true,
                  onChange: event => setName(event.target.value),
                })),
                h(Field, { label: "字符集" }, h("input", {
                  className: "mst-input",
                  value: charset,
                  onChange: event => setCharset(event.target.value),
                })),
                h(Field, { label: "排序规则（可选）", hint: "留空则使用字符集默认排序规则。" }, h("input", {
                  className: "mst-input",
                  value: collation,
                  placeholder: "utf8mb4_0900_ai_ci",
                  onChange: event => setCollation(event.target.value),
                })),
              )
              : h(
                "div",
                { className: "mst-form" },
                h(Field, { label: "CREATE DATABASE", hint: "只允许一条 CREATE DATABASE / CREATE SCHEMA。" }, h("textarea", {
                  className: "mst-textarea",
                  value: advanced,
                  spellCheck: false,
                  onChange: event => setAdvanced(event.target.value),
                })),
              ),
            error !== "" ? h("div", { className: "mst-error" }, error) : null,
          ),
          h(
            "div",
            { className: "mst-card-foot" },
            h("button", { className: "mst-btn", type: "button", onClick: props.onCancel }, "取消"),
            h("button", { className: "mst-btn primary", type: "button", disabled: props.busy, onClick: onSubmit }, "预览并创建"),
          ),
        ),
      );
    }

    function defaultTableColumns() {
      return [
        { name: "id", type: "INT", nullable: false, primaryKey: true, autoIncrement: true },
        { name: "name", type: "VARCHAR(255)", nullable: false, primaryKey: false, autoIncrement: false },
      ];
    }

    /** Create-table dialog: column list on the form tab, CREATE TABLE on the SQL tab. */
    function CreateTableDialog(props) {
      const [tab, setTab] = useState("form");
      const [name, setName] = useState("");
      const [engine, setEngine] = useState("InnoDB");
      const [charset, setCharset] = useState("utf8mb4");
      const [collation, setCollation] = useState("");
      const [columns, setColumns] = useState(defaultTableColumns);
      const [advanced, setAdvanced] = useState(
        "CREATE TABLE `" + props.database + "`.`new_table` (\n  `id` INT NOT NULL AUTO_INCREMENT,\n  `name` VARCHAR(255) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
      );
      const [error, setError] = useState("");

      const setColumn = (index, patch) => {
        setColumns(previous => previous.map((column, at) => at === index ? { ...column, ...patch } : column));
      };

      const onSubmit = () => {
        setError("");
        try {
          if (tab === "sql") {
            if (advanced.trim() === "") throw new Error("SQL 不能为空");
            props.onSubmit({ database: props.database, sql: advanced });
            return;
          }
          if (name.trim() === "") throw new Error("请填写表名");
          if (columns.length === 0) throw new Error("至少定义一列");
          props.onSubmit({
            database: props.database,
            name: name.trim(),
            engine: engine.trim(),
            charset: charset.trim(),
            collation: collation.trim(),
            columns,
          });
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      };

      const form = h(
        "div",
        { className: "mst-form" },
        h("div", { className: "mst-hint" }, "库：" + props.database),
        h(
          "div",
          { className: "mst-fieldrow" },
          h(Field, { label: "表名" }, h("input", {
            className: "mst-input",
            value: name,
            autoFocus: true,
            onChange: event => setName(event.target.value),
          })),
          h(Field, { label: "引擎" }, h("input", {
            className: "mst-input",
            value: engine,
            onChange: event => setEngine(event.target.value),
          })),
        ),
        h(
          "div",
          { className: "mst-fieldrow" },
          h(Field, { label: "字符集" }, h("input", {
            className: "mst-input",
            value: charset,
            onChange: event => setCharset(event.target.value),
          })),
          h(Field, { label: "排序规则（可选）" }, h("input", {
            className: "mst-input",
            value: collation,
            onChange: event => setCollation(event.target.value),
          })),
        ),
        h("div", { className: "mst-hint" }, "列"),
        columns.map((column, index) =>
          h(
            "div",
            { className: "mst-colrow", key: index },
            h("input", {
              className: "mst-input",
              value: column.name,
              placeholder: "列名",
              onChange: event => setColumn(index, { name: event.target.value }),
            }),
            h(
              "select",
              {
                className: "mst-select",
                value: COLUMN_TYPES.includes(column.type) ? column.type : "INT",
                onChange: event => setColumn(index, { type: event.target.value }),
              },
              COLUMN_TYPES.map(type => h("option", { key: type, value: type }, type)),
            ),
            h("label", { className: "mst-check" }, h("input", {
              type: "checkbox",
              checked: column.nullable !== false,
              onChange: event => setColumn(index, { nullable: event.target.checked }),
            }), "可空"),
            h("label", { className: "mst-check" }, h("input", {
              type: "checkbox",
              checked: column.primaryKey === true,
              onChange: event => setColumn(index, { primaryKey: event.target.checked }),
            }), "主键"),
            h("label", { className: "mst-check" }, h("input", {
              type: "checkbox",
              checked: column.autoIncrement === true,
              onChange: event => setColumn(index, event.target.checked
                ? { autoIncrement: true, nullable: false, primaryKey: true }
                : { autoIncrement: false }),
            }), "自增"),
            h("button", {
              className: "mst-btn link",
              type: "button",
              onClick: () => setColumns(previous => previous.filter((_, at) => at !== index)),
            }, "删除"),
          ),
        ),
        h("button", {
          className: "mst-btn",
          type: "button",
          onClick: () => setColumns(previous => [...previous, { name: "", type: "VARCHAR(255)", nullable: true, primaryKey: false, autoIncrement: false }]),
        }, "添加列"),
      );

      return h(
        "div",
        { className: "mst-modal", onMouseDown: event => { if (event.target === event.currentTarget) props.onCancel(); } },
        h(
          "div",
          { className: "mst-card wide" },
          h(
            "div",
            { className: "mst-card-head" },
            "新建表",
            h("span", { className: "mst-spacer" }),
            h("button", { className: "mst-btn link", type: "button", onClick: props.onCancel }, "✕"),
          ),
          h(
            "div",
            { className: "mst-tabs" },
            h("button", { className: "mst-tab" + (tab === "form" ? " active" : ""), type: "button", onClick: () => setTab("form") }, "表单"),
            h("button", { className: "mst-tab" + (tab === "sql" ? " active" : ""), type: "button", onClick: () => setTab("sql") }, "高级 SQL"),
          ),
          h(
            "div",
            { className: "mst-card-body" },
            tab === "form"
              ? form
              : h(
                "div",
                { className: "mst-form" },
                h(Field, { label: "CREATE TABLE", hint: "只允许一条 CREATE TABLE。" }, h("textarea", {
                  className: "mst-textarea",
                  style: { minHeight: 180 },
                  value: advanced,
                  spellCheck: false,
                  onChange: event => setAdvanced(event.target.value),
                })),
              ),
            error !== "" ? h("div", { className: "mst-error" }, error) : null,
          ),
          h(
            "div",
            { className: "mst-card-foot" },
            h("button", { className: "mst-btn", type: "button", onClick: props.onCancel }, "取消"),
            h("button", { className: "mst-btn primary", type: "button", disabled: props.busy, onClick: onSubmit }, "预览并创建"),
          ),
        ),
      );
    }

    // ── the connection editor ─────────────────────────────────────────────

    const EMPTY_DRAFT = {
      name: "",
      host: "127.0.0.1",
      port: "3306",
      user: "root",
      password: "",
      database: "",
      charset: "utf8mb4",
      sslMode: "disabled",
      sslCa: "",
      url: "",
    };

    /** Map a stored profile onto the form's flat draft. */
    function draftFrom(profile) {
      if (!profile) return { ...EMPTY_DRAFT };
      const ssl = profile.ssl || {};
      return {
        id: profile.id,
        name: profile.name || "",
        host: profile.host || "",
        port: String(profile.port || 3306),
        user: profile.user || "",
        // An empty box means "keep the stored password", which the host reads
        // as an absent key rather than a cleared one.
        password: "",
        hasPassword: profile.hasPassword === true,
        database: profile.database || "",
        charset: profile.charset || "utf8mb4",
        sslMode: ssl.mode === "preferred"
          ? "required"
          : ssl.mode === "verify-identity"
            ? "verify-ca"
            : (ssl.mode || "disabled"),
        sslCa: ssl.ca || "",
        url: "",
      };
    }

    /** Turn the form's flat draft into the host's profile draft. */
    function profileDraft(form) {
      const draft = {
        name: form.name,
        host: form.host,
        port: form.port,
        user: form.user,
        database: form.database,
        charset: form.charset,
        ssl: {
          mode: form.sslMode,
          ca: form.sslCa,
        },
      };
      if (form.id !== undefined) draft.id = form.id;
      // Only send a password when the user typed one; an untouched box keeps
      // whatever the host already stored.
      if (form.password !== "") draft.password = form.password;
      return draft;
    }

    function ConnectionEditor(props) {
      const [tab, setTab] = useState("basic");
      const [form, setForm] = useState(() => draftFrom(props.profile));
      const [busy, setBusy] = useState("");
      const [result, setResult] = useState(null);
      const [error, setError] = useState("");

      const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

      const onParseUrl = async () => {
        setError("");
        setResult(null);
        if (form.url.trim() === "") {
          setError("请先粘贴一条连接 URL。");
          return;
        }
        setBusy("parse");
        try {
          const parsed = await callApi("conn.parseUrl", { url: form.url });
          const draft = parsed.draft || {};
          setForm(previous => ({
            ...previous,
            host: draft.host || previous.host,
            port: draft.port === undefined ? previous.port : String(draft.port),
            user: draft.user || previous.user,
            password: draft.password === undefined ? previous.password : draft.password,
            database: draft.database || previous.database,
            charset: draft.charset || previous.charset,
            sslMode: draft.ssl && draft.ssl.mode ? draft.ssl.mode : previous.sslMode,
          }));
          setTab("basic");
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy("");
        }
      };

      const onTest = async () => {
        setError("");
        setResult(null);
        setBusy("test");
        try {
          const draft = profileDraft(form);
          // An untouched password box means "use what is stored", which the host
          // resolves by merging this draft over the saved profile — so the key is
          // omitted entirely rather than sent as an empty string (that would
          // clear it) or as undefined (that would stringify).
          if (form.password === "") delete draft.password;
          setResult(await callApi("conn.test", { id: form.id, draft }));
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy("");
        }
      };

      const onSave = async () => {
        setError("");
        setBusy("save");
        try {
          await props.onSave(profileDraft(form));
        } catch (failure) {
          setError(failure.message);
          setBusy("");
        }
      };

      const basic = h(
        "div",
        { className: "mst-form" },
        h(Field, { label: "连接名" }, h("input", {
          className: "mst-input",
          value: form.name,
          placeholder: "留空则用 user@host",
          onChange: event => set("name", event.target.value),
        })),
        h(
          "div",
          { className: "mst-fieldrow" },
          h(Field, { label: "主机" }, h("input", {
            className: "mst-input",
            value: form.host,
            onChange: event => set("host", event.target.value),
          })),
          h(Field, { label: "端口" }, h("input", {
            className: "mst-input",
            value: form.port,
            onChange: event => set("port", event.target.value),
          })),
        ),
        h(
          "div",
          { className: "mst-fieldrow" },
          h(Field, { label: "用户名" }, h("input", {
            className: "mst-input",
            value: form.user,
            onChange: event => set("user", event.target.value),
          })),
          h(Field, { label: "密码" }, h("input", {
            className: "mst-input",
            type: "password",
            value: form.password,
            placeholder: form.hasPassword ? "已保存，留空则不修改" : "",
            onChange: event => set("password", event.target.value),
          })),
        ),
        h(
          "div",
          { className: "mst-fieldrow" },
          h(Field, { label: "默认库（可选）" }, h("input", {
            className: "mst-input",
            value: form.database,
            onChange: event => set("database", event.target.value),
          })),
          h(Field, { label: "字符集" }, h("input", {
            className: "mst-input",
            value: form.charset,
            onChange: event => set("charset", event.target.value),
          })),
        ),
      );

      const ssl = h(
        "div",
        { className: "mst-form" },
        h(
          Field,
          {
            label: "TLS 模式",
            hint: "required 只加密不校验证书；verify-ca 校验 CA。旧文档里的 preferred 会当成 required，verify-identity 会当成 verify-ca。",
          },
          h(
            "select",
            { className: "mst-select", value: form.sslMode, onChange: event => set("sslMode", event.target.value) },
            h("option", { value: "disabled" }, "disabled — 不加密"),
            h("option", { value: "required" }, "required — 必须加密（不校验证书）"),
            h("option", { value: "verify-ca" }, "verify-ca — 校验 CA"),
          ),
        ),
        form.sslMode === "disabled"
          ? h("div", { className: "mst-hint" }, "当前未启用 TLS。")
          : h(Field, { label: "CA 证书（PEM 文本或文件绝对路径）" }, h("textarea", {
            className: "mst-textarea",
            value: form.sslCa,
            onChange: event => set("sslCa", event.target.value),
          })),
      );

      const urlTab = h(
        "div",
        { className: "mst-form" },
        h(
          Field,
          {
            label: "粘贴连接 URL",
            hint: "支持 mysql://user:pass@host:3306/db?ssl-mode=required、jdbc:mysql://…?user=&password=&useSSL=true、以及 host:3306/db。解析结果会填进“基础”页，可再手工修改。",
          },
          h("textarea", {
            className: "mst-textarea",
            value: form.url,
            placeholder: "mysql://root:root@192.168.100.128:3307/case_prod",
            onChange: event => set("url", event.target.value),
          }),
        ),
        h("button", { className: "mst-btn", type: "button", disabled: busy !== "", onClick: onParseUrl }, "解析并填入"),
      );

      return h(
        "div",
        { className: "mst-modal", onMouseDown: event => { if (event.target === event.currentTarget) props.onCancel(); } },
        h(
          "div",
          { className: "mst-card" },
          h(
            "div",
            { className: "mst-card-head" },
            h(DatabaseIcon, { size: 14 }),
            props.profile ? "编辑连接" : "新建 MySQL 连接",
            h("span", { className: "mst-spacer" }),
            h("button", { className: "mst-btn link", type: "button", onClick: props.onCancel }, "✕"),
          ),
          h(
            "div",
            { className: "mst-tabs" },
            [
              { key: "basic", label: "基础" },
              { key: "ssl", label: "SSL/TLS" },
              { key: "url", label: "URL 粘贴" },
            ].map(entry =>
              h(
                "button",
                {
                  key: entry.key,
                  type: "button",
                  className: "mst-tab" + (tab === entry.key ? " active" : ""),
                  onClick: () => setTab(entry.key),
                },
                entry.label,
              ),
            ),
          ),
          h(
            "div",
            { className: "mst-card-body" },
            tab === "basic"
              ? basic
              : tab === "ssl" ? ssl : urlTab,
            error !== "" ? h("div", { className: "mst-error" }, error) : null,
            result !== null
              ? h(
                "div",
                { className: "mst-pad" },
                h("div", { className: "mst-ok" }, "连接成功 · MySQL " + (result.version || "?") + " · " + result.latencyMs + "ms"),
                h("div", { className: "mst-hint" }, "当前用户：" + (result.currentUser || "?")),
              )
              : null,
          ),
          h(
            "div",
            { className: "mst-card-foot" },
            h("button", { className: "mst-btn", type: "button", disabled: busy !== "", onClick: onTest }, busy === "test" ? "测试中…" : "测试连接"),
            h("button", { className: "mst-btn", type: "button", onClick: props.onCancel }, "取消"),
            h("button", { className: "mst-btn primary", type: "button", disabled: busy === "save", onClick: onSave }, "保存"),
          ),
        ),
      );
    }

    // ── the workbench ─────────────────────────────────────────────────────

    function Studio() {
      const [connections, setConnections] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [databases, setDatabases] = useState([]);
      const [expandedDb, setExpandedDb] = useState(null);
      const [tables, setTables] = useState([]);
      const [selection, setSelection] = useState(null);
      const [view, setView] = useState("data");
      const [columns, setColumns] = useState([]);
      const [page, setPage] = useState(null);
      const [offset, setOffset] = useState(0);
      const [editor, setEditor] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [sql, setSql] = useState("SELECT VERSION()");
      const [sqlResult, setSqlResult] = useState(null);
      // Pending writes: per-row cell edits, rows marked for deletion, and rows
      // staged for insert. Nothing leaves the browser until 提交.
      const [edits, setEdits] = useState({});
      const [deletions, setDeletions] = useState({});
      const [inserts, setInserts] = useState([]);
      const [draft, setDraft] = useState(null);
      const [concurrency, setConcurrency] = useState("pk-changed");
      const [plan, setPlan] = useState(null);
      const [schemaDialog, setSchemaDialog] = useState(null);
      const [sqlPreview, setSqlPreview] = useState(null);
      const mounted = useRef(true);

      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      /** Run an async step, routing its failure into the banner instead of throwing. */
      const guard = useCallback(async (label, work) => {
        setBusy(label);
        setError("");
        try {
          return await work();
        } catch (failure) {
          if (mounted.current) setError(failure.message);
          return undefined;
        } finally {
          if (mounted.current) setBusy("");
        }
      }, []);

      /** Drop every pending write; used when the page or the table changes. */
      const clearPending = useCallback(() => {
        setEdits({});
        setDeletions({});
        setInserts([]);
        setDraft(null);
        setPlan(null);
      }, []);

      const clearSelection = useCallback(() => {
        setSelection(null);
        setColumns([]);
        setPage(null);
        setOffset(0);
        setSqlResult(null);
        clearPending();
      }, [clearPending]);

      const reloadConnections = useCallback(async () => {
        const result = await guard("list", () => callApi("conn.list"));
        if (result !== undefined) setConnections(result.connections || []);
        return result;
      }, [guard]);

      useEffect(() => { void reloadConnections(); }, [reloadConnections]);

      /** Select a connection and load its schemas. */
      const selectConnection = useCallback(async id => {
        setActiveId(id);
        setExpandedDb(null);
        setTables([]);
        setDatabases([]);
        clearSelection();
        const result = await guard("databases", () => callApi("catalog.databases", { id }));
        if (result !== undefined) setDatabases(result.databases || []);
      }, [guard, clearSelection]);

      /** Expand a schema and load its relations. */
      const toggleDatabase = useCallback(async (id, name) => {
        if (expandedDb === name) {
          setExpandedDb(null);
          setTables([]);
          return;
        }
        setExpandedDb(name);
        setTables([]);
        const result = await guard("tables", () => callApi("catalog.tables", { id, database: name }));
        if (result !== undefined) setTables(result.tables || []);
      }, [expandedDb, guard]);

      /** Load one page of a table, plus its column metadata. */
      const loadTable = useCallback(async (id, database, table, nextOffset) => {
        const result = await guard("rows", () => callApi("data.rows", {
          id,
          database,
          table,
          limit: PAGE_SIZE,
          offset: nextOffset,
        }));
        if (result === undefined) return;
        setPage(result);
        setOffset(nextOffset);
        setSelection({ database, table });
      }, [guard]);

      const selectTable = useCallback(async (database, table) => {
        setView("data");
        setSqlResult(null);
        setColumns([]);
        clearPending();
        // Structure and data are independent reads; the structure is small and
        // always useful, so it loads alongside the first page.
        void guard("columns", () => callApi("catalog.columns", {
          id: activeId,
          database,
          table,
        })).then(result => {
          if (result !== undefined) setColumns(result.columns || []);
        });
        await loadTable(activeId, database, table, 0);
      }, [activeId, guard, loadTable, clearPending]);

      const refreshTable = useCallback(() => {
        if (selection === null) return;
        // Reloading replaces the rows pending edits were written against, so the
        // pending state goes with them — after asking, not silently.
        if (Object.keys(edits).length > 0 || Object.keys(deletions).length > 0 || inserts.length > 0) {
          if (!window.confirm("刷新会丢弃尚未提交的改动，继续？")) return;
          clearPending();
        }
        void loadTable(activeId, selection.database, selection.table, offset);
      }, [activeId, selection, offset, loadTable, edits, deletions, inserts, clearPending]);

      // ── pending writes ─────────────────────────────────────────────────

      const metaByName = useMemo(() => {
        const map = new Map();
        for (const column of columns) map.set(column.name, column);
        return map;
      }, [columns]);

      // A commit identifies rows by primary key, so a keyless table is read-only.
      const canEdit = page !== null && page.primaryKey.length > 0;

      const onEditCell = useCallback((rowIndex, columnName, value) => {
        setPlan(null);
        setEdits(previous => {
          const row = { ...(previous[rowIndex] || {}) };
          const at = page.columns.findIndex(column => column.name === columnName);
          const loaded = at === -1 ? null : page.rows[rowIndex][at];
          // Typing the loaded value back un-marks the cell rather than staging a
          // write that would do nothing.
          if (sameCell(value, loaded)) delete row[columnName];
          else row[columnName] = value;
          const next = { ...previous };
          if (Object.keys(row).length === 0) delete next[rowIndex];
          else next[rowIndex] = row;
          return next;
        });
      }, [page]);

      const onDeleteRow = useCallback(rowIndex => {
        setPlan(null);
        setDeletions(previous => ({ ...previous, [rowIndex]: true }));
      }, []);

      const onRestoreRow = useCallback(rowIndex => {
        setPlan(null);
        setDeletions(previous => {
          const next = { ...previous };
          delete next[rowIndex];
          return next;
        });
      }, []);

      const onDraftCell = useCallback((columnName, value) => {
        setDraft(previous => ({ ...(previous || {}), [columnName]: value }));
      }, []);

      const onDraftConfirm = useCallback(() => {
        const values = {};
        for (const [key, value] of Object.entries(draft || {})) {
          // An empty box means "leave it out", so the column's own DEFAULT (or
          // AUTO_INCREMENT) applies instead of an empty string.
          if (value === "") continue;
          values[key] = value;
        }
        if (Object.keys(values).length === 0) {
          setError("新增行至少要填一列；留空的列会使用数据库默认值。");
          return;
        }
        setError("");
        setInserts(previous => [...previous, values]);
        setDraft(null);
      }, [draft]);

      const mutations = useCallback(
        () => (page === null ? [] : buildMutations(page, edits, deletions, inserts)),
        [page, edits, deletions, inserts],
      );

      const pendingRows = useMemo(
        () => (page === null ? 0 : pendingRowCount(edits, deletions, inserts)),
        [page, edits, deletions, inserts],
      );

      const pendingCells = useMemo(
        () => (page === null ? 0 : pendingCellCount(page, edits, deletions, inserts)),
        [page, edits, deletions, inserts],
      );

      const mutate = useCallback(async dryRun => {
        const result = await callApi("data.mutate", {
          id: activeId,
          database: selection.database,
          table: selection.table,
          concurrency,
          mutations: mutations(),
          dryRun,
        });
        if (dryRun) setPlan(result);
        return result;
      }, [activeId, selection, concurrency, mutations]);

      const onPreview = useCallback(async () => {
        if (page === null) return;
        await guard("preview", () => mutate(true));
      }, [page, guard, mutate]);

      const onCommit = useCallback(async () => {
        if (page === null) return;
        setPlan(null);
        await guard("commit", async () => {
          const result = await mutate(false);
          const skipped = result.skipped === undefined ? 0 : result.skipped.length;
          setNotice("已提交 " + result.statements.length + " 条语句" + (skipped > 0 ? "，跳过 " + skipped + " 处无实际变化" : ""));
          clearPending();
          // Read the page back through the same path the grid uses, so what is
          // shown after a commit is what the server actually holds.
          const refreshed = await callApi("data.rows", {
            id: activeId,
            database: selection.database,
            table: selection.table,
            limit: PAGE_SIZE,
            offset,
          });
          if (mounted.current) setPage(refreshed);
        });
      }, [page, guard, mutate, clearPending, activeId, selection, offset]);

      const onDiscard = useCallback(() => {
        clearPending();
        setNotice("已放弃未提交的改动");
      }, [clearPending]);

      const onSaveConnection = useCallback(async draft => {
        const saved = await callApi("conn.save", { draft });
        setEditor(null);
        setNotice("已保存连接 " + saved.connection.name);
        await reloadConnections();
        await selectConnection(saved.connection.id);
      }, [reloadConnections, selectConnection]);

      const onDeleteConnection = useCallback(async id => {
        if (!window.confirm("删除这个连接配置？该操作只删除本地保存的连接，不会影响数据库。")) return;
        await guard("delete", () => callApi("conn.delete", { id }));
        setActiveId(null);
        setDatabases([]);
        setTables([]);
        setExpandedDb(null);
        clearSelection();
        await reloadConnections();
      }, [guard, reloadConnections, clearSelection]);

      const sqlDatabase = (selection && selection.database) || expandedDb || undefined;

      const reloadCatalog = useCallback(async database => {
        if (activeId === null) return;
        const listed = await callApi("catalog.databases", { id: activeId });
        if (mounted.current) setDatabases(listed.databases || []);
        const target = database || expandedDb;
        if (target) {
          const listedTables = await callApi("catalog.tables", { id: activeId, database: target });
          if (mounted.current) {
            setExpandedDb(target);
            setTables(listedTables.tables || []);
          }
        }
      }, [activeId, expandedDb]);

      const openSqlPreview = useCallback((title, sql, run) => {
        setSqlPreview({ title, sql, run });
      }, []);

      const onRunSql = useCallback(async () => {
        const result = await guard("sql", () => callApi("query.exec", {
          id: activeId,
          database: sqlDatabase,
          sql,
          limit: PAGE_SIZE,
        }));
        if (result === undefined) return;
        if (result.needsConfirm === true) {
          openSqlPreview("确认执行写语句", result.sql, async () => {
            const executed = await callApi("query.exec", {
              id: activeId,
              database: sqlDatabase,
              sql: result.sql,
              limit: PAGE_SIZE,
              confirmSql: result.sql,
            });
            setSqlPreview(null);
            setSqlResult(executed);
            setNotice(
              executed.kind === "read"
                ? "已执行"
                : "已执行 · 影响 " + (executed.affectedRows === null || executed.affectedRows === undefined ? "?" : executed.affectedRows) + " 行",
            );
            if (executed.kind !== "read") await reloadCatalog(sqlDatabase);
          });
          return;
        }
        setSqlResult(result);
      }, [activeId, guard, sql, sqlDatabase, openSqlPreview, reloadCatalog]);

      const onExportSql = useCallback(() => {
        if (sqlResult === null || sqlResult.rows.length === 0) {
          setError("没有可导出的结果");
          return;
        }
        try {
          const text = formatInsertSql({
            database: selection === null ? undefined : selection.database,
            table: selection === null ? undefined : selection.table,
            columns: sqlResult.columns,
            rows: sqlResult.rows,
          });
          const stem = selection === null
            ? "query-result"
            : selection.database + "." + selection.table;
          downloadText(stem + ".sql", text);
          setNotice("已导出 " + sqlResult.rows.length + " 行 INSERT");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, [sqlResult, selection]);

      const onCreateDatabase = useCallback(async payload => {
        const planned = await guard("schema", () => callApi("schema.createDatabase", {
          id: activeId,
          ...payload,
          dryRun: true,
        }));
        if (planned === undefined) return;
        openSqlPreview("确认创建库", planned.sql, async () => {
          await callApi("schema.createDatabase", {
            id: activeId,
            ...payload,
            confirmSql: planned.sql,
          });
          setSqlPreview(null);
          setSchemaDialog(null);
          setNotice("已创建库");
          await reloadCatalog(payload.name);
        });
      }, [activeId, guard, openSqlPreview, reloadCatalog]);

      const onCreateTable = useCallback(async payload => {
        const planned = await guard("schema", () => callApi("schema.createTable", {
          id: activeId,
          ...payload,
          dryRun: true,
        }));
        if (planned === undefined) return;
        openSqlPreview("确认创建表", planned.sql, async () => {
          await callApi("schema.createTable", {
            id: activeId,
            ...payload,
            confirmSql: planned.sql,
          });
          setSqlPreview(null);
          setSchemaDialog(null);
          setNotice("已创建表 " + (payload.name || ""));
          await reloadCatalog(payload.database);
        });
      }, [activeId, guard, openSqlPreview, reloadCatalog]);

      const active = useMemo(
        () => connections.find(entry => entry.id === activeId) || null,
        [connections, activeId],
      );

      // ── the object tree ────────────────────────────────────────────────

      const tree = h(
        "aside",
        { className: "mst-tree" },
        connections.length === 0
          ? h("div", { className: "mst-empty" }, "还没有连接。", h("br"), "点右上角「新建连接」开始。")
          : h(
            React.Fragment,
            null,
            h("div", { className: "mst-group" }, "连接"),
            connections.map(connection =>
              h(
                React.Fragment,
                { key: connection.id },
                h(
                  "div",
                  {
                    className: "mst-row" + (connection.id === activeId ? " active" : ""),
                    title: connection.user + "@" + connection.host + ":" + connection.port,
                    onClick: () => void selectConnection(connection.id),
                  },
                  h(DatabaseIcon, { size: 12 }),
                  h("span", null, connection.name),
                ),
                connection.id === activeId
                  ? h(
                    React.Fragment,
                    null,
                    databases.map(database =>
                      h(
                        React.Fragment,
                        { key: database.name },
                        h(
                          "div",
                          {
                            className: "mst-row db",
                            onClick: () => void toggleDatabase(connection.id, database.name),
                          },
                          h("span", { className: "mst-caret" }, expandedDb === database.name ? "▾" : "▸"),
                          h("span", null, database.name),
                          database.system ? h("span", { className: "mst-badge" }, "sys") : null,
                        ),
                        expandedDb === database.name
                          ? h(
                            React.Fragment,
                            null,
                            tables.length === 0
                              ? h("div", { className: "mst-row table" }, h("span", { className: "mst-hint" }, busy === "tables" ? "加载中…" : "（无表）"))
                              : tables.map(table =>
                                h(
                                  "div",
                                  {
                                    key: table.name,
                                    className: "mst-row table"
                                      + (selection !== null && selection.database === database.name && selection.table === table.name ? " active" : ""),
                                    title: (table.comment || table.name) + "  ·  " + (table.type || ""),
                                    onClick: () => void selectTable(database.name, table.name),
                                  },
                                  h("span", null, table.name),
                                  h("span", { className: "mst-count" }, formatCount(table.estimatedRows)),
                                ),
                              ),
                            h(
                              "div",
                              {
                                className: "mst-row table",
                                onClick: event => {
                                  event.stopPropagation();
                                  setSchemaDialog({ kind: "table", database: database.name });
                                },
                              },
                              h("span", { className: "mst-hint" }, "＋ 新建表"),
                            ),
                          )
                          : null,
                      ),
                    ),
                    h(
                      "div",
                      {
                        className: "mst-row db",
                        onClick: () => setSchemaDialog({ kind: "database" }),
                      },
                      h("span", { className: "mst-hint" }, "＋ 新建库"),
                    ),
                  )
                  : null,
              ),
            ),
          ),
      );

      // ── the main pane ──────────────────────────────────────────────────

      let main
      if (connections.length === 0) {
        main = h(
          "div",
          { className: "mst-empty" },
          h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "MySQL Studio"),
          "还没有任何连接。点右上角「新建连接」，支持手工填写、SSL/TLS 配置，以及直接粘贴连接 URL。",
          h("br"),
          h("br"),
          "连接配置保存在 DSH 主目录的 mysql-studio/connections.json；密码只留在 Host 半，不会回传到页面。",
        );
      } else if (active === null) {
        main = h("div", { className: "mst-empty" }, "从左侧选择一个连接。");
      } else if (view === "sql") {
        const sqlMeta = sqlResult === null
          ? (sqlDatabase ? "默认库 " + sqlDatabase + " · " : "") + "读立即执行；写会先弹出原文确认"
          : sqlResult.kind === "read" || (sqlResult.rows && sqlResult.rows.length > 0)
            ? sqlResult.rows.length + " 行 · " + sqlResult.elapsedMs + "ms" + (sqlResult.truncated ? " · 已截断" : "")
            : "影响 " + (sqlResult.affectedRows === null || sqlResult.affectedRows === undefined ? "?" : sqlResult.affectedRows) + " 行 · " + sqlResult.elapsedMs + "ms";
        const sqlEditor = h(
          "div",
          { className: "mst-sql" },
          h("textarea", {
            className: "mst-textarea",
            value: sql,
            spellCheck: false,
            placeholder: "一条语句。SELECT 立即执行；INSERT / UPDATE / DELETE / DDL 会先弹出原文确认。",
            onChange: event => setSql(event.target.value),
            onKeyDown: event => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void onRunSql();
              }
            },
          }),
          h(
            "div",
            { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            h("button", { className: "mst-btn primary", type: "button", disabled: busy !== "", onClick: () => void onRunSql() }, busy === "sql" ? "执行中…" : "执行 (Ctrl+Enter)"),
            h("button", {
              className: "mst-btn",
              type: "button",
              disabled: busy !== "" || sqlResult === null || !sqlResult.rows || sqlResult.rows.length === 0,
              onClick: onExportSql,
              title: "把当前结果导出为 INSERT 语句",
            }, "导出 INSERT"),
            h("span", { className: "mst-hint" }, sqlMeta),
          ),
          sqlResult !== null && sqlResult.rows && sqlResult.rows.length > 0
            ? h(Grid, { columns: sqlResult.columns, rows: sqlResult.rows })
            : null,
        );
        if (selection === null) {
          main = sqlEditor;
        } else {
          const tableLabel = selection.database + "." + selection.table;
          main = h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "mst-tabs" },
              h("button", { className: "mst-tab", type: "button", onClick: () => setView("data") }, "数据"),
              h("button", {
                className: "mst-tab",
                type: "button",
                onClick: () => setView("columns"),
              }, "结构" + (columns.length > 0 ? " (" + columns.length + ")" : "")),
              h("button", { className: "mst-tab active", type: "button" }, "SQL"),
              h("span", { className: "mst-spacer" }),
              h("span", { className: "mst-hint", style: { paddingRight: 6 } }, tableLabel),
            ),
            sqlEditor,
          );
        }
      } else if (selection === null) {
        main = h(
          "div",
          { className: "mst-pad" },
          h("div", { style: { fontWeight: 600, fontSize: 13 } }, active.name),
          h(
            "dl",
            { className: "mst-kv" },
            h("dt", null, "地址"), h("dd", null, active.host + ":" + active.port),
            h("dt", null, "用户"), h("dd", null, active.user),
            h("dt", null, "默认库"), h("dd", null, active.database || "（未指定）"),
            h("dt", null, "字符集"), h("dd", null, active.charset || "utf8mb4"),
            h("dt", null, "TLS"), h("dd", null, (active.ssl && active.ssl.mode) || "disabled"),
            h("dt", null, "密码"), h("dd", null, active.hasPassword ? "已保存" : "（未保存）"),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 6 } },
            h("button", { className: "mst-btn", type: "button", onClick: () => setEditor({ profile: active }) }, "编辑"),
            h("button", { className: "mst-btn", type: "button", onClick: () => void onDeleteConnection(active.id) }, "删除"),
            h("button", {
              className: "mst-btn",
              type: "button",
              disabled: busy !== "",
              onClick: () => void guard("test", () => callApi("conn.test", { id: active.id })).then(result => {
                if (result !== undefined) setNotice("连接正常 · " + result.version + " · " + result.latencyMs + "ms");
              }),
            }, "测试连接"),
            h("button", {
              className: "mst-btn",
              type: "button",
              onClick: () => setSchemaDialog({ kind: "database" }),
            }, "新建库"),
          ),
          h("div", { className: "mst-hint" }, "展开左侧的库，点一张表即可查看数据。"),
        );
      } else {
        const tableLabel = selection.database + "." + selection.table;
        const tabs = h(
          "div",
          { className: "mst-tabs" },
          h("button", {
            className: "mst-tab" + (view === "data" ? " active" : ""),
            type: "button",
            onClick: () => setView("data"),
          }, "数据"),
          h("button", {
            className: "mst-tab" + (view === "columns" ? " active" : ""),
            type: "button",
            onClick: () => setView("columns"),
          }, "结构" + (columns.length > 0 ? " (" + columns.length + ")" : "")),
          h("button", {
            className: "mst-tab" + (view === "sql" ? " active" : ""),
            type: "button",
            onClick: () => setView("sql"),
          }, "SQL"),
          h("span", { className: "mst-spacer" }),
          h("span", { className: "mst-hint", style: { paddingRight: 6 } }, tableLabel),
        );

        let content
        if (view === "columns") {
          content = h(ColumnsView, { columns });
        } else {
          const loaded = page === null ? 0 : page.rows.length;
          const span = page === null ? "" : page.hasMore ? offset + 1 + "–" + (offset + loaded) + " / 更多" : offset + 1 + "–" + (offset + loaded);
          content = h(
            React.Fragment,
            null,
            page === null
              ? h("div", { className: "mst-empty" }, busy === "rows" ? "加载中…" : "没有数据。")
              : h(EditableGrid, {
                page,
                metaByName,
                edits,
                deletions,
                inserts,
                draft,
                canEdit,
                offset,
                onEdit: onEditCell,
                onDeleteRow,
                onRestoreRow,
                onDraftCell,
                onDraftConfirm,
              }),
            pendingRows > 0
              ? h(
                "div",
                { className: "mst-pending" },
                h("span", { className: "mst-strong" }, "待提交 " + pendingRows + " 行改动"),
                h("span", { className: "mst-hint" }, pendingCells + " 处单元格"),
                deletions && Object.keys(deletions).length > 0
                  ? h("span", { className: "mst-hint" }, "（含删除 " + Object.keys(deletions).length + " 行）")
                  : null,
                h("span", { className: "mst-spacer" }),
                h(
                  "label",
                  { className: "mst-hint", title: "并发校验决定提交时用多少原值去定位行：pk 最宽松（后写覆盖），pk-changed 会保护你真正改动的那些格" },
                  "并发校验 ",
                  h(
                    "select",
                    {
                      className: "mst-select",
                      value: concurrency,
                      onChange: event => { setConcurrency(event.target.value); setPlan(null); },
                    },
                    h("option", { value: "pk" }, "仅主键（后写覆盖）"),
                    h("option", { value: "pk-changed" }, "主键 + 改动列原值（推荐）"),
                  ),
                ),
                h("button", {
                  className: "mst-btn",
                  type: "button",
                  disabled: busy !== "",
                  onClick: () => void onPreview(),
                }, busy === "preview" ? "生成中…" : "查看 SQL"),
                h("button", { className: "mst-btn", type: "button", disabled: busy !== "", onClick: onDiscard }, "放弃"),
                h("button", {
                  className: "mst-btn primary",
                  type: "button",
                  disabled: busy !== "",
                  onClick: () => void onCommit(),
                }, busy === "commit" ? "提交中…" : "提交"),
              )
              : null,
            h(
              "div",
              { className: "mst-foot" },
              h("span", null, span),
              page !== null && canEdit
                ? h("button", {
                  className: "mst-btn",
                  type: "button",
                  disabled: draft !== null || busy !== "",
                  onClick: () => setDraft({}),
                }, "新增行")
                : null,
              h("span", { className: "mst-spacer" }),
              h("button", {
                className: "mst-btn",
                type: "button",
                disabled: offset === 0 || busy !== "",
                onClick: () => void loadTable(activeId, selection.database, selection.table, Math.max(0, offset - PAGE_SIZE)),
              }, "上一页"),
              h("button", {
                className: "mst-btn",
                type: "button",
                disabled: page === null || !page.hasMore || busy !== "",
                onClick: () => void loadTable(activeId, selection.database, selection.table, offset + PAGE_SIZE),
              }, "下一页"),
              h("button", { className: "mst-btn", type: "button", disabled: busy !== "", onClick: refreshTable }, "刷新"),
              page !== null && page.primaryKey.length === 0
                ? h("span", { className: "mst-hint" }, "该表无主键：只读")
                : null,
            ),
          );
        }
        main = h(React.Fragment, null, tabs, content);
      }

      // ── shell ──────────────────────────────────────────────────────────

      return h(
        "div",
        { className: "mst-root", style: { position: "relative" } },
        h(
          "div",
          { className: "mst-head" },
          h("span", { className: "mst-title" }, h(DatabaseIcon, { size: 13 }), "MySQL Studio"),
          connections.length > 0
            ? h(
              "select",
              {
                className: "mst-select",
                value: activeId === null ? "" : activeId,
                onChange: event => {
                  if (event.target.value !== "") void selectConnection(event.target.value);
                },
              },
              h("option", { value: "" }, "选择连接…"),
              connections.map(connection =>
                h("option", { key: connection.id, value: connection.id }, connection.name),
              ),
            )
            : null,
          h("span", { className: "mst-spacer" }),
          busy !== "" ? h("span", { className: "mst-hint" }, "加载中…") : null,
          h("button", {
            className: "mst-btn",
            type: "button",
            disabled: activeId === null || busy !== "",
            onClick: refreshTable,
            title: "重新读取当前表",
          }, "刷新"),
          h("button", {
            className: "mst-btn",
            type: "button",
            disabled: activeId === null || busy !== "",
            onClick: () => setView("sql"),
            title: "编写并执行 SQL",
          }, "查询"),
          h("button", {
            className: "mst-btn primary",
            type: "button",
            onClick: () => setEditor({ profile: null }),
          }, "新建连接"),
        ),
        error !== "" ? h("div", { className: "mst-error" }, error) : null,
        notice !== "" ? h("div", { className: "mst-error", style: { borderColor: "var(--dsw-alias-state-success-primary)", color: "var(--dsw-alias-state-success-primary)" } }, notice) : null,
        h("div", { className: "mst-body" }, tree, h("main", { className: "mst-main" }, main)),
        editor !== null
          ? h(ConnectionEditor, {
            profile: editor.profile,
            onCancel: () => setEditor(null),
            onSave: onSaveConnection,
          })
          : null,
        plan !== null
          ? h(
            "div",
            { className: "mst-modal", onMouseDown: event => { if (event.target === event.currentTarget) setPlan(null); } },
            h(
              "div",
              { className: "mst-card" },
              h(
                "div",
                { className: "mst-card-head" },
                "提交预览",
                h("span", { className: "mst-spacer" }),
                h("button", { className: "mst-btn link", type: "button", onClick: () => setPlan(null) }, "✕"),
              ),
              h(
                "div",
                { className: "mst-card-body" },
                h(
                  "div",
                  { className: "mst-pad" },
                  plan.statements.length === 0
                    ? h("div", { className: "mst-hint" }, "没有需要执行的语句——待提交的格都和数据库里当前值一致。")
                    : h(
                      React.Fragment,
                      null,
                      h("div", { className: "mst-hint" },
                        "以下 " + plan.statements.length + " 条语句会在一个事务里执行；"
                        + "任何一条影响行数不是 1，整个事务回滚。"),
                      h("pre", { className: "mst-sqlpreview" }, plan.statements.map(sql => sql + ";").join("\n\n")),
                    ),
                  plan.skipped !== undefined && plan.skipped.length > 0
                    ? h("div", { className: "mst-hint" }, "另有 " + plan.skipped.length + " 处提交被跳过（无实际变化）。")
                    : null,
                ),
              ),
              h(
                "div",
                { className: "mst-card-foot" },
                h("button", { className: "mst-btn", type: "button", onClick: () => setPlan(null) }, "返回修改"),
                h("button", {
                  className: "mst-btn primary",
                  type: "button",
                  disabled: plan.statements.length === 0 || busy !== "",
                  onClick: () => void onCommit(),
                }, "确认提交"),
              ),
            ),
          )
          : null,
        sqlPreview !== null
          ? h(
            "div",
            { className: "mst-modal front", onMouseDown: event => { if (event.target === event.currentTarget) setSqlPreview(null); } },
            h(
              "div",
              { className: "mst-card wide" },
              h(
                "div",
                { className: "mst-card-head" },
                sqlPreview.title,
                h("span", { className: "mst-spacer" }),
                h("button", { className: "mst-btn link", type: "button", onClick: () => setSqlPreview(null) }, "✕"),
              ),
              h(
                "div",
                { className: "mst-card-body" },
                h(
                  "div",
                  { className: "mst-pad" },
                  h("div", { className: "mst-hint" }, "以下是即将执行的原文 SQL。确认后才会发给数据库。"),
                  h("pre", { className: "mst-sqlpreview" }, sqlPreview.sql),
                ),
              ),
              h(
                "div",
                { className: "mst-card-foot" },
                h("button", { className: "mst-btn", type: "button", onClick: () => setSqlPreview(null) }, "返回修改"),
                h("button", {
                  className: "mst-btn primary",
                  type: "button",
                  disabled: busy !== "",
                  onClick: () => void guard("sql", sqlPreview.run),
                }, busy === "sql" || busy === "schema" ? "执行中…" : "确认执行"),
              ),
            ),
          )
          : null,
        schemaDialog !== null && schemaDialog.kind === "database"
          ? h(CreateDatabaseDialog, {
            busy: busy === "schema",
            onCancel: () => setSchemaDialog(null),
            onSubmit: payload => void onCreateDatabase(payload),
          })
          : null,
        schemaDialog !== null && schemaDialog.kind === "table"
          ? h(CreateTableDialog, {
            database: schemaDialog.database,
            busy: busy === "schema",
            onCancel: () => setSchemaDialog(null),
            onSubmit: payload => void onCreateTable(payload),
          })
          : null,
      );
    }

    // ── sidebar integration ───────────────────────────────────────────────

    /** The description both registration surfaces show in the sidebar guide. */
    const TITLE = () => "MySQL Studio";
    const DESCRIPTION = () => "连接 MySQL、浏览库表结构与数据、编辑并提交行改动、执行 SQL";

    /**
     * Register with `ctx.betterSidebar` when dsh-better-sidebar is installed.
     *
     * That plugin republishes every descriptor it receives as a native DSH tab
     * type under `dsh-better-sidebar:<id>`, so this path reaches the same right
     * column as the direct one — while also inheriting its guide entry and
     * side-card enable switch.
     *
     * @returns the opener, or `null` when the service is absent.
     */
    function viaBetterSidebar(ctx) {
      const better = ctx.get("betterSidebar");
      if (better === undefined || typeof better.registerTab !== "function") return null;
      ctx.effect(() => better.registerTab({
        id: KIND,
        title: TITLE,
        description: DESCRIPTION,
        icon: size => h(DatabaseIcon, { size: typeof size === "number" ? size : 14 }),
        order: 60,
        // One workbench per session: a second open focuses the first.
        single: true,
        component: Studio,
      }), "dsh-mysql-studio: better-sidebar tab");
      return () => {
        const live = ctx.get("betterSidebar");
        if (live !== undefined) live.openTab({ type: KIND, title: TITLE() });
      };
    }

    /**
     * Register straight into DSH's native right Sidebar.
     *
     * Two stages, because that is the contract: the type goes into
     * `ctx.sidebarRightTabs` (static: kind, title, guide entry), and the body
     * goes into the keyed `sidebar.right.pane.tab` slot under the same `id`.
     *
     * @returns the opener, or `null` when the native registry is absent.
     */
    function viaNative(ctx) {
      const tabs = ctx.get("sidebarRightTabs");
      const right = ctx.get("sidebarRight");
      const slots = ctx.get("slots");
      if (tabs === undefined || right === undefined || slots === undefined) return null;
      if (typeof tabs.register !== "function" || typeof right.openTab !== "function") return null;

      ctx.effect(() => tabs.register({
        id: NATIVE_ID,
        kind: KIND,
        priority: "extension",
        title: TITLE,
        guide: [{ order: 60, title: TITLE, description: DESCRIPTION, icon: DatabaseIcon }],
      }), "dsh-mysql-studio: native tab type");

      ctx.effect(() => slots.inject("sidebar.right.pane.tab", () => slots.register({
        name: "sidebar.right.pane.tab",
        key: NATIVE_ID,
        // The workbench reads nothing from the tab record, but the slot's
        // registration face still expects a provider.
        inject: () => ({}),
      }, Studio)), "dsh-mysql-studio: native tab body");

      return () => {
        const live = ctx.get("sidebarRight");
        if (live !== undefined) live.openTab(KIND);
      };
    }

    /**
     * Choose the registration surface and open the workbench.
     *
     * The choice is made once and is deferred briefly: a co-resident
     * dsh-better-sidebar publishes `betterSidebar` during ITS apply, and client
     * bundles materialize in composition order rather than ours, so committing
     * to the native path the instant `sidebarRightTabs` exists would sometimes
     * miss the richer integration. `ctx.inject` short-circuits the wait the
     * moment the service appears.
     */
    function install(ctx) {
      let opener = null;
      let settled = false;

      const decide = attempt => {
        if (settled) return;
        const better = viaBetterSidebar(ctx);
        if (better !== null) {
          opener = better;
          settled = true;
          return;
        }
        // Nothing native to register into yet: `ctx.inject` re-runs this the
        // moment `sidebarRightTabs` appears, so waiting here costs nothing.
        if (ctx.get("sidebarRightTabs") === undefined) return;
        // Give a co-resident dsh-better-sidebar its apply turn before committing
        // to the plain native path — it publishes `betterSidebar` during its own
        // apply, and client bundles materialize in composition order, not ours.
        if (attempt < 12) {
          setTimeout(() => decide(attempt + 1), 50);
          return;
        }
        const native = viaNative(ctx);
        if (native !== null) {
          opener = native;
          settled = true;
        }
      };

      decide(0);
      if (typeof ctx.inject === "function") {
        // Whichever surface shows up first re-runs the decision; `decide` is
        // idempotent, so the later one is a no-op.
        ctx.inject(["betterSidebar"], () => decide(12));
        ctx.inject(["sidebarRightTabs"], () => decide(0));
      }

      // The opener is kept for the fiber's whole life: registering a tab type
      // and opening one are separate acts, and the user may open the workbench
      // any number of times after the first.
      return () => {
        if (opener !== null) opener();
      };
    }

    // ── plugin body ───────────────────────────────────────────────────────

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(installStyles, "dsh-mysql-studio: stylesheet");
      const open = install(ctx);
      // A small convenience face for other plugins and for the console: opening
      // the workbench is a deliberate act, so nothing auto-opens a tab at boot —
      // the type simply appears in the sidebar's new-tab guide.
      ctx.provide("mysqlStudio", { open, call: callApi });
    }

    exports.apply = apply;
    exports.inject = inject;
    // Exported for the test suite. The pending-state translation and the
    // components are pure functions of their props, but they live inside the
    // bundle closure and the bundle is a classic script (the loader's `require`
    // resolves baseline modules, not relative paths), so they cannot be split
    // into a separately importable module. A render path no test can reach is a
    // render path that crashes into a blank tab.
    exports.__internals = {
      sameCell,
      readOnlyReason,
      rowObject,
      rowKeyOf,
      buildMutations,
      pendingRowCount,
      pendingCellCount,
      formatCell,
      formatCount,
      formatInsertSql,
      sqlLiteral,
      quoteId,
      binaryInfo,
      draftFrom,
      profileDraft,
      EMPTY_DRAFT,
      COLUMN_TYPES,
      DatabaseIcon,
      Grid,
      ColumnsView,
      EditableGrid,
      ConnectionEditor,
      CreateDatabaseDialog,
      CreateTableDialog,
      Studio,
    };
    return module.exports;
  },
});
