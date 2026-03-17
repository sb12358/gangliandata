import { useCallback, useEffect, useMemo, useState } from "react"
import Plot from "react-plotly.js"
import { AlertTriangle, Download, Filter, LineChart, RefreshCcw, Search } from "lucide-react"

import { MultiSelect } from "@/components/multi-select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface TableOption {
  cn: string
  en: string
  table_name: string
}

interface FilterMeta {
  table_cn: string
  table_name: string
  indicator_names: string[]
  indicator_codes: string[]
  date_min: string
  date_max: string
  value_min: number | null
  value_max: number | null
  total_count: number
}

interface QueryRow {
  indicator_code: string
  indicator_name: string
  value: number | null
  unit: string
  frequency: string
  datetime: string
}

interface QueryStats {
  avg: number | null
  min: number | null
  max: number | null
  median: number | null
  std: number | null
}

interface QueryResponse {
  table_cn: string
  table_name: string
  total_count: number
  row_count: number
  limit: number
  truncated: boolean
  stats: QueryStats
  rows: QueryRow[]
}

interface FiltersState {
  indicatorName: string
  indicatorCode: string
  dateStart: string
  dateEnd: string
  enableValueFilter: boolean
  valueMin: string
  valueMax: string
}

const DEFAULT_TABLE_CN = "全量"
const DEFAULT_LIMIT = 5000

const initialFilters: FiltersState = {
  indicatorName: "全部",
  indicatorCode: "全部",
  dateStart: "",
  dateEnd: "",
  enableValueFilter: false,
  valueMin: "",
  valueMax: "",
}

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 })

function toDateInput(value?: string | null) {
  if (!value) {
    return ""
  }
  return String(value).slice(0, 10)
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-"
  }
  return numberFormatter.format(value)
}

function buildPayload(tableCn: string, filters: FiltersState) {
  return {
    table_cn: tableCn,
    indicator_name: filters.indicatorName === "全部" ? "" : filters.indicatorName,
    indicator_code: filters.indicatorCode === "全部" ? "" : filters.indicatorCode,
    date_start: filters.dateStart,
    date_end: filters.dateEnd,
    enable_value_filter: filters.enableValueFilter,
    value_min: filters.enableValueFilter && filters.valueMin !== "" ? Number(filters.valueMin) : null,
    value_max: filters.enableValueFilter && filters.valueMax !== "" ? Number(filters.valueMax) : null,
    limit: DEFAULT_LIMIT,
  }
}

function safeDateLabel(v: string) {
  return String(v).slice(0, 10)
}

function pickFilename(disposition: string | null, fallback: string) {
  if (!disposition) {
    return fallback
  }
  const utfMatch = disposition.match(/filename\*=UTF-8([^;]+)/i)
  if (utfMatch && utfMatch[1]) {
    return decodeURIComponent(utfMatch[1])
  }
  const simpleMatch = disposition.match(/filename="?([^\"]+)"?/i)
  if (simpleMatch && simpleMatch[1]) {
    return simpleMatch[1]
  }
  return fallback
}

export default function App() {
  const [tables, setTables] = useState<TableOption[]>([])
  const [selectedTableCn, setSelectedTableCn] = useState(DEFAULT_TABLE_CN)
  const [meta, setMeta] = useState<FilterMeta | null>(null)
  const [filters, setFilters] = useState<FiltersState>(initialFilters)
  const [result, setResult] = useState<QueryResponse | null>(null)

  const [isLoadingTables, setIsLoadingTables] = useState(false)
  const [isLoadingMeta, setIsLoadingMeta] = useState(false)
  const [isLoadingQuery, setIsLoadingQuery] = useState(false)
  const [error, setError] = useState("")

  const [trendIndicators, setTrendIndicators] = useState<string[]>([])
  const [trendStart, setTrendStart] = useState("")
  const [trendEnd, setTrendEnd] = useState("")
  const [manualYRange, setManualYRange] = useState(false)
  const [trendYMin, setTrendYMin] = useState("")
  const [trendYMax, setTrendYMax] = useState("")

  const rows = result?.rows ?? []

  const applyMetaDefaults = useCallback((m: FilterMeta): FiltersState => {
    return {
      indicatorName: "全部",
      indicatorCode: "全部",
      dateStart: toDateInput(m.date_min),
      dateEnd: toDateInput(m.date_max),
      enableValueFilter: false,
      valueMin: m.value_min === null ? "" : String(m.value_min),
      valueMax: m.value_max === null ? "" : String(m.value_max),
    }
  }, [])

  const runQuery = useCallback(async (tableCn: string, filtersToUse: FiltersState) => {
    setIsLoadingQuery(true)
    setError("")
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(tableCn, filtersToUse)),
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || "查询失败")
      }
      const data = (await response.json()) as QueryResponse
      setResult(data)
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : "查询失败")
    } finally {
      setIsLoadingQuery(false)
    }
  }, [])

  useEffect(() => {
    const loadTables = async () => {
      setIsLoadingTables(true)
      setError("")
      try {
        const response = await fetch("/api/tables")
        if (!response.ok) {
          throw new Error("无法获取数据表")
        }
        const data = (await response.json()) as { tables: TableOption[] }
        setTables(data.tables)

        const preferred = data.tables.find((item) => item.cn === DEFAULT_TABLE_CN)?.cn ?? data.tables[0]?.cn
        if (preferred) {
          setSelectedTableCn(preferred)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "无法获取数据表")
      } finally {
        setIsLoadingTables(false)
      }
    }

    void loadTables()
  }, [])

  useEffect(() => {
    if (!selectedTableCn) {
      return
    }

    let cancelled = false

    const loadMetaAndQuery = async () => {
      setIsLoadingMeta(true)
      setError("")
      try {
        const response = await fetch(`/api/filter-meta?table_cn=${encodeURIComponent(selectedTableCn)}`)
        if (!response.ok) {
          throw new Error("无法获取筛选项")
        }
        const data = (await response.json()) as FilterMeta
        if (cancelled) {
          return
        }
        setMeta(data)

        const nextFilters = applyMetaDefaults(data)
        setFilters(nextFilters)
        await runQuery(selectedTableCn, nextFilters)
      } catch (err) {
        if (!cancelled) {
          setMeta(null)
          setResult(null)
          setError(err instanceof Error ? err.message : "加载失败")
        }
      } finally {
        if (!cancelled) {
          setIsLoadingMeta(false)
        }
      }
    }

    void loadMetaAndQuery()

    return () => {
      cancelled = true
    }
  }, [applyMetaDefaults, runQuery, selectedTableCn])

  const indicatorNamesInRows = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.indicator_name).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const dateValuesInRows = useMemo(() => {
    return Array.from(new Set(rows.map((row) => safeDateLabel(row.datetime)).filter(Boolean))).sort()
  }, [rows])

  useEffect(() => {
    if (indicatorNamesInRows.length === 0) {
      setTrendIndicators([])
    } else {
      setTrendIndicators((prev) => {
        const kept = prev.filter((item) => indicatorNamesInRows.includes(item))
        return kept.length > 0 ? kept : [indicatorNamesInRows[0]]
      })
    }

    if (dateValuesInRows.length === 0) {
      setTrendStart("")
      setTrendEnd("")
    } else {
      setTrendStart(dateValuesInRows[0])
      setTrendEnd(dateValuesInRows[dateValuesInRows.length - 1])
    }

    setManualYRange(false)
    setTrendYMin("")
    setTrendYMax("")
  }, [dateValuesInRows, indicatorNamesInRows])

  const trendRows = useMemo(() => {
    const activeIndicators = trendIndicators.length > 0 ? trendIndicators : indicatorNamesInRows.slice(0, 1)

    return rows.filter((row) => {
      const dateKey = safeDateLabel(row.datetime)
      const indicatorMatched = activeIndicators.includes(row.indicator_name)
      const afterStart = trendStart ? dateKey >= trendStart : true
      const beforeEnd = trendEnd ? dateKey <= trendEnd : true
      return indicatorMatched && afterStart && beforeEnd
    })
  }, [rows, trendIndicators, indicatorNamesInRows, trendStart, trendEnd])

  const chartData = useMemo(() => {
    const grouped = new Map<string, QueryRow[]>()

    trendRows.forEach((row) => {
      if (!grouped.has(row.indicator_name)) {
        grouped.set(row.indicator_name, [])
      }
      grouped.get(row.indicator_name)?.push(row)
    })

    return Array.from(grouped.entries()).map(([name, values]) => {
      const sorted = [...values].sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
      return {
        x: sorted.map((item) => safeDateLabel(item.datetime)),
        y: sorted.map((item) => item.value),
        type: "scatter",
        mode: "lines+markers",
        name,
        line: {
          width: 2,
        },
        marker: {
          size: 6,
        },
      }
    })
  }, [trendRows])

  const autoYBounds = useMemo(() => {
    const vals = trendRows.map((item) => item.value).filter((item): item is number => item !== null && Number.isFinite(item))
    if (vals.length === 0) {
      return { min: null, max: null }
    }
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }, [trendRows])

  const chartLayout = useMemo(() => {
    const hasManualY = manualYRange && trendYMin !== "" && trendYMax !== ""
    const yMin = hasManualY ? Number(trendYMin) : undefined
    const yMax = hasManualY ? Number(trendYMax) : undefined

    return {
      autosize: true,
      height: 460,
      margin: { l: 60, r: 24, t: 24, b: 60 },
      paper_bgcolor: "rgba(255,255,255,0)",
      plot_bgcolor: "rgba(255,255,255,0.85)",
      hovermode: "x unified",
      dragmode: "zoom",
      legend: {
        orientation: "h",
        y: 1.1,
      },
      xaxis: {
        title: "日期",
        type: "date",
        range: trendStart && trendEnd ? [trendStart, trendEnd] : undefined,
        rangeslider: {
          visible: true,
          thickness: 0.14,
          bgcolor: "#dce9ff",
          bordercolor: "#8eb0ff",
          borderwidth: 1,
        },
      },
      yaxis: {
        title: "值",
        fixedrange: false,
        automargin: true,
        range: hasManualY ? [yMin, yMax] : undefined,
      },
    }
  }, [manualYRange, trendEnd, trendStart, trendYMax, trendYMin])

  const handleQueryClick = async () => {
    await runQuery(selectedTableCn, filters)
  }

  const handleResetClick = async () => {
    if (!meta) {
      return
    }
    const next = applyMetaDefaults(meta)
    setFilters(next)
    await runQuery(selectedTableCn, next)
  }

  const handleExportClick = async () => {
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(selectedTableCn, filters)),
      })
      if (!response.ok) {
        throw new Error("导出失败")
      }
      const blob = await response.blob()
      const fallback = `${selectedTableCn}.csv`
      const filename = pickFilename(response.headers.get("Content-Disposition"), fallback)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败")
    }
  }

  return (
    <div className="container py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">期货数据分析平台</h1>
          <p className="text-sm text-muted-foreground">真正 React + shadcn/ui 版本</p>
        </div>
        <Badge variant="secondary">http://localhost:8502</Badge>
      </div>

      {error ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm">{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside>
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-5 w-5" /> 查询条件
              </CardTitle>
              <CardDescription>基于当前已选择的数据表进行筛选</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>指标名称</Label>
                <Select
                  value={filters.indicatorName}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, indicatorName: value }))}
                  disabled={isLoadingMeta || !meta}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择指标名称" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="全部">全部</SelectItem>
                    {(meta?.indicator_names ?? []).map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>指标代码</Label>
                <Select
                  value={filters.indicatorCode}
                  onValueChange={(value) => setFilters((prev) => ({ ...prev, indicatorCode: value }))}
                  disabled={isLoadingMeta || !meta}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择指标代码" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="全部">全部</SelectItem>
                    {(meta?.indicator_codes ?? []).map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>日期范围</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
                  <Input
                    type="date"
                    value={filters.dateStart}
                    min={toDateInput(meta?.date_min)}
                    max={toDateInput(meta?.date_max)}
                    onChange={(event) => setFilters((prev) => ({ ...prev, dateStart: event.target.value }))}
                    disabled={isLoadingMeta || !meta}
                  />
                  <Input
                    type="date"
                    value={filters.dateEnd}
                    min={toDateInput(meta?.date_min)}
                    max={toDateInput(meta?.date_max)}
                    onChange={(event) => setFilters((prev) => ({ ...prev, dateEnd: event.target.value }))}
                    disabled={isLoadingMeta || !meta}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="value-filter"
                    checked={filters.enableValueFilter}
                    onCheckedChange={(checked) =>
                      setFilters((prev) => ({
                        ...prev,
                        enableValueFilter: checked === true,
                      }))
                    }
                  />
                  <Label htmlFor="value-filter">按数值范围筛选</Label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    value={filters.valueMin}
                    step="any"
                    onChange={(event) => setFilters((prev) => ({ ...prev, valueMin: event.target.value }))}
                    disabled={!filters.enableValueFilter}
                    placeholder="最小值"
                  />
                  <Input
                    type="number"
                    value={filters.valueMax}
                    step="any"
                    onChange={(event) => setFilters((prev) => ({ ...prev, valueMax: event.target.value }))}
                    disabled={!filters.enableValueFilter}
                    placeholder="最大值"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button onClick={() => void handleQueryClick()} disabled={isLoadingQuery || isLoadingMeta || isLoadingTables}>
                  <Search className="h-4 w-4" /> 查询
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleResetClick()}
                  disabled={isLoadingQuery || isLoadingMeta || !meta}
                >
                  <RefreshCcw className="h-4 w-4" /> 重置
                </Button>
              </div>
            </CardContent>
          </Card>
        </aside>

        <main className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>数据表展示</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedTableCn} onValueChange={setSelectedTableCn} disabled={isLoadingTables || tables.length === 0}>
                <SelectTrigger className="max-w-xl">
                  <SelectValue placeholder="选择数据表" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map((table) => (
                    <SelectItem key={table.cn} value={table.cn}>
                      {table.cn} ({table.en})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>查询结果</CardTitle>
                <CardDescription>
                  {result
                    ? `共 ${result.total_count.toLocaleString("zh-CN")} 条，当前显示 ${result.row_count.toLocaleString("zh-CN")} 条`
                    : "请先选择数据表"}
                </CardDescription>
              </div>
              <Button variant="outline" onClick={() => void handleExportClick()} disabled={!result || result.row_count === 0}>
                <Download className="h-4 w-4" /> 导出 CSV
              </Button>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>数据表</CardTitle>
              <CardDescription>
                字段: indicator code / indicator name / value / unit / frequency / datetime
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[420px] rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>indicator code</TableHead>
                      <TableHead>indicator name</TableHead>
                      <TableHead>value</TableHead>
                      <TableHead>unit</TableHead>
                      <TableHead>frequency</TableHead>
                      <TableHead>datetime</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length > 0 ? (
                      rows.map((row, index) => (
                        <TableRow key={`${row.indicator_code}-${row.datetime}-${index}`}>
                          <TableCell>{row.indicator_code}</TableCell>
                          <TableCell>{row.indicator_name}</TableCell>
                          <TableCell>{formatNumber(row.value)}</TableCell>
                          <TableCell>{row.unit || "-"}</TableCell>
                          <TableCell>{row.frequency || "-"}</TableCell>
                          <TableCell>{safeDateLabel(row.datetime)}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          {isLoadingQuery ? "正在加载..." : "暂无数据"}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>数值统计</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div className="stat-card">
                  <p className="text-xs text-muted-foreground">平均值</p>
                  <p className="mt-1 text-lg font-semibold">{formatNumber(result?.stats.avg)}</p>
                </div>
                <div className="stat-card">
                  <p className="text-xs text-muted-foreground">最小值</p>
                  <p className="mt-1 text-lg font-semibold">{formatNumber(result?.stats.min)}</p>
                </div>
                <div className="stat-card">
                  <p className="text-xs text-muted-foreground">最大值</p>
                  <p className="mt-1 text-lg font-semibold">{formatNumber(result?.stats.max)}</p>
                </div>
                <div className="stat-card">
                  <p className="text-xs text-muted-foreground">中位数</p>
                  <p className="mt-1 text-lg font-semibold">{formatNumber(result?.stats.median)}</p>
                </div>
                <div className="stat-card">
                  <p className="text-xs text-muted-foreground">标准差</p>
                  <p className="mt-1 text-lg font-semibold">{formatNumber(result?.stats.std)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LineChart className="h-5 w-5" /> 趋势图
              </CardTitle>
              <CardDescription>支持单选/多选指标名称，多条折线同图展示，X/Y 轴都可控</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
                <div className="space-y-2 xl:col-span-2">
                  <Label>指标名称（可多选）</Label>
                  <MultiSelect options={indicatorNamesInRows} value={trendIndicators} onChange={setTrendIndicators} placeholder="选择指标名称" />
                </div>

                <div className="space-y-2">
                  <Label>起始日期</Label>
                  <Select value={trendStart || "__none_start__"} onValueChange={(value) => setTrendStart(value === "__none_start__" ? "" : value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="起始日期" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none_start__">最早</SelectItem>
                      {dateValuesInRows.map((item) => (
                        <SelectItem key={`start-${item}`} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>结束日期</Label>
                  <Select value={trendEnd || "__none_end__"} onValueChange={(value) => setTrendEnd(value === "__none_end__" ? "" : value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="结束日期" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none_end__">最晚</SelectItem>
                      {dateValuesInRows.map((item) => (
                        <SelectItem key={`end-${item}`} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
                <div className="flex items-center gap-2 xl:col-span-2">
                  <Checkbox
                    id="manual-y"
                    checked={manualYRange}
                    onCheckedChange={(checked) => {
                      const enabled = checked === true
                      setManualYRange(enabled)
                      if (enabled) {
                        setTrendYMin(autoYBounds.min === null ? "" : String(autoYBounds.min))
                        setTrendYMax(autoYBounds.max === null ? "" : String(autoYBounds.max))
                      }
                    }}
                  />
                  <Label htmlFor="manual-y">手动设置 Y 轴范围（解决上沿截断问题）</Label>
                </div>
                <Input
                  type="number"
                  step="any"
                  placeholder="Y 最小值"
                  disabled={!manualYRange}
                  value={trendYMin}
                  onChange={(event) => setTrendYMin(event.target.value)}
                />
                <Input
                  type="number"
                  step="any"
                  placeholder="Y 最大值"
                  disabled={!manualYRange}
                  value={trendYMax}
                  onChange={(event) => setTrendYMax(event.target.value)}
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    setManualYRange(false)
                    setTrendYMin("")
                    setTrendYMax("")
                  }}
                >
                  还原 Y 轴
                </Button>
              </div>

              <div className="rounded-xl border bg-white/80 p-2">
                <Plot
                  data={chartData as never[]}
                  layout={chartLayout as never}
                  config={{
                    responsive: true,
                    displaylogo: false,
                    scrollZoom: true,
                    modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
                  }}
                  style={{ width: "100%" }}
                />
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  )
}
