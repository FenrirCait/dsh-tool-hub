interface Window {
  __ModuleLoader__: {
    load(entry: { id: string; factory: (require: (name: string) => unknown) => unknown }): void
  }
}
declare module '*.svg' {
  const text: string
  export default text
}
