declare module '@monaco-editor/loader' {
  const loader: {
    config: (options: { paths?: { vs?: string } }) => void
    init: () => Promise<any>
  }
  export default loader
}
