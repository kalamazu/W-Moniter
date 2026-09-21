export default [
  {
    file: 'src/renderer/src/components/PaneGrid.tsx',
    label: '下拉框套一层壳（自绘箭头）',
    old: `              <select
                className="pane-pick"
                value={id}
                title="这一栏显示哪个面板"
                onChange={(event) => onPick(index, event.target.value as PanelId)}
              >
                {PANELS.map((panel) => (
                  <option key={panel.id} value={panel.id}>
                    {panel.label}
                  </option>
                ))}
              </select>`,
    new: `              <span className="pane-pick-wrap">
                <select
                  className="pane-pick"
                  value={id}
                  title="换这一栏显示的面板"
                  onChange={(event) => onPick(index, event.target.value as PanelId)}
                >
                  {PANELS.map((panel) => (
                    <option key={panel.id} value={panel.id}>
                      {panel.label}
                    </option>
                  ))}
                </select>
              </span>`
  },
  {
    file: 'src/renderer/src/App.css',
    label: '栏头下拉框做成明显的胶囊',
    old: `.pane-pick {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}

.pane-pick:hover {
  border-color: var(--line);
  background: var(--panel);
}`,
    new: `/* 栏头这个下拉框是「瀑布图 / 统计 那些面板都去哪了」的唯一入口 ——
   以前它是无边框的、看着像一段标题文字，用户根本认不出能点。做成明显的胶囊 + 自绘箭头 */
.pane-pick-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.pane-pick-wrap::after {
  content: '▾';
  position: absolute;
  right: 7px;
  font-size: 9px;
  color: var(--muted);
  pointer-events: none;
}

.pane-pick {
  appearance: none;
  -webkit-appearance: none;
  max-width: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 3px 20px 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}

.pane-pick:hover,
.pane-pick:focus-visible {
  border-color: var(--accent);
  background: var(--panel-2);
  outline: none;
}

.pane-pick option {
  background: var(--panel-2);
  color: var(--text);
}`
  }
]