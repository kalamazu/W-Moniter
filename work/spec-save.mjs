export default [
  {
    file: 'src/renderer/src/App.tsx',
    label: '落盘改为立刻写',
    old: `  // 布局变了就落盘。防抖 400ms —— 拖分隔条会连着改好几次，不必每一帧都写盘
  const saveTimer = useRef<number | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useEffect(() => {
    if (!layoutReady) return
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void window.monitor
        .setUiSettings({ layout })
        .catch((error: unknown) => console.error('保存界面偏好失败', error))
    }, 400)
  }, [layout, layoutReady])

  // 关窗口时把还没落盘的那次补上（防抖窗口里退出，不该丢掉用户刚摆的布局）
  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current)
        void window.monitor.setUiSettings({ layout: layoutRef.current })
      }
    },
    []
  )`,
    new: `  // 布局一变就落盘。原来是 400ms 防抖 + 「关窗口补一次」，实测补不上：关窗口是
  // 直接拆渲染进程，React 的卸载清理根本不跑，防抖窗口里退出就真把那一下丢了。
  // 而拖动只在松手时提交一次 state，本来也没有写盘风暴要压 —— 那就直接写。
  useEffect(() => {
    if (!layoutReady) return
    void window.monitor
      .setUiSettings({ layout })
      .catch((error: unknown) => console.error('保存界面偏好失败', error))
  }, [layout, layoutReady])`
  }
]