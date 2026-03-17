import React from "react"
import ReactDOM from "react-dom/client"
import "./index.css"

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { errorMessage: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { errorMessage: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { errorMessage: error.message || "前端运行时发生错误" }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("React runtime error:", error, info)
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div style={{ padding: "24px", fontFamily: "sans-serif" }}>
          <h2 style={{ marginBottom: "8px" }}>页面加载失败</h2>
          <p style={{ marginBottom: "8px" }}>前端发生运行时错误，请刷新页面后重试。</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#fff4e5",
              border: "1px solid #f5c26b",
              borderRadius: "8px",
              padding: "12px",
            }}
          >
            {this.state.errorMessage}
          </pre>
        </div>
      )
    }

    return this.props.children
  }
}

function FatalScreen({ message }: { message: string }) {
  return (
    <div style={{ padding: "24px", fontFamily: "sans-serif" }}>
      <h2 style={{ marginBottom: "8px" }}>页面加载失败</h2>
      <p style={{ marginBottom: "8px" }}>应用初始化失败，请刷新页面后重试。</p>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#fff4e5",
          border: "1px solid #f5c26b",
          borderRadius: "8px",
          padding: "12px",
        }}
      >
        {message}
      </pre>
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById("root")!)

async function bootstrap() {
  try {
    const appModule = await import("./App")
    const App = appModule.default

    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>
    )
  } catch (err) {
    console.error("App bootstrap failed:", err)
    const message = err instanceof Error ? err.message : String(err)
    root.render(<FatalScreen message={message} />)
  }
}

void bootstrap()
