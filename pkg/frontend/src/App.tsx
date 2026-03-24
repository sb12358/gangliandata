import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Filter, LineChart, RefreshCcw, Search } from "lucide-react"
import { ColorType, CrosshairMode, LineSeries, createChart, type IChartApi, type LineData, type Time, type WhitespaceData } from "lightweight-charts"

import { MultiSelect } from "@/components/multi-select"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  indicatorNameLike: string
  indicatorCodeLike: string
  dateStart: string
  dateEnd: string
  enableValueFilter: boolean
  valueMin: string
  valueMax: string
}

const DEFAULT_TABLE_CN = "全量"
const DEFAULT_LIMIT = 5000

const EMPTY_ROWS: QueryRow[] = []
const TREND_COLORS = ["#2563eb", "#f97316", "#16a34a", "#dc2626", "#7c3aed", "#0891b2", "#ca8a04", "#db2777"]

interface TrendSeriesConfig {
  name: string
  color: string
  data: Array<LineData<Time> | WhitespaceData<Time>>
}

const initialFilters: FiltersState = {
  indicatorName: "全部",
  indicatorCode: "全部",
  indicatorNameLike: "",
  indicatorCodeLike: "",
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
    indicator_name_like: filters.indicatorNameLike.trim(),
    indicator_code_like: filters.indicatorCodeLike.trim(),
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

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const text = await response.text()
    if (!text) {
      return fallback
    }
    try {
      const parsed = JSON.parse(text) as { detail?: string }
      if (parsed?.detail) {
        return parsed.detail
      }
    } catch {
      return text
    }
    return text
  } catch {
    return fallback
  }
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
  const [filtersCollapsed, setFiltersCollapsed] = useState(false)

  const [trendIndicators, setTrendIndicators] = useState<string[]>([])
  const [trendStart, setTrendStart] = useState("")
  const [trendEnd, setTrendEnd] = useState("")
  const [manualYRange, setManualYRange] = useState(false)
  const [trendYMin, setTrendYMin] = useState("")
  const [trendYMax, setTrendYMax] = useState("")
  const [plotLoadError, setPlotLoadError] = useState("")
  const plotContainerRef = useRef<HTMLDivElement | null>(null)
  const chartApiRef = useRef<IChartApi | null>(null)

  const rows = result?.rows ?? EMPTY_ROWS

  const indicatorNameOptions = useMemo(() => {
    return (meta?.indicator_names ?? [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0)
  }, [meta?.indicator_names])

  const indicatorCodeOptions = useMemo(() => {
    return (meta?.indicator_codes ?? [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0)
  }, [meta?.indicator_codes])

  const applyMetaDefaults = useCallback((m: FilterMeta): FiltersState => {
    return {
      indicatorName: "全部",
      indicatorCode: "全部",
      indicatorNameLike: "",
      indicatorCodeLike: "",
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
          throw new Error(await readErrorMessage(response, "无法获取数据表"))
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
          throw new Error(await readErrorMessage(response, "无法获取筛选项"))
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
      setTrendIndicators((prev) => (prev.length === 0 ? prev : []))
    } else {
      setTrendIndicators((prev) => {
        const kept = prev.filter((item) => indicatorNamesInRows.includes(item))
        const next = kept.length > 0 ? kept : [indicatorNamesInRows[0]]
        if (prev.length === next.length && prev.every((item, idx) => item === next[idx])) {
          return prev
        }
        return next
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

  const trendSeriesData = useMemo<TrendSeriesConfig[]>(() => {
    const grouped = new Map<string, QueryRow[]>()

    trendRows.forEach((row) => {
      if (!grouped.has(row.indicator_name)) {
        grouped.set(row.indicator_name, [])
      }
      grouped.get(row.indicator_name)?.push(row)
    })

    return Array.from(grouped.entries()).map(([name, values], index) => {
      const sorted = [...values].sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
      return {
        name,
        color: TREND_COLORS[index % TREND_COLORS.length],
        data: sorted.map((item) => {
          const time = safeDateLabel(item.datetime)
          if (item.value === null || !Number.isFinite(item.value)) {
            return { time }
          }
          return { time, value: item.value }
        }),
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

  useEffect(() => {
    const el = plotContainerRef.current
    if (!el) {
      return
    }

    chartApiRef.current?.remove()
    chartApiRef.current = null
    el.innerHTML = ""

    try {
      const hasManualY = manualYRange && trendYMin !== "" && trendYMax !== ""
      const yMin = hasManualY ? Number(trendYMin) : null
      const yMax = hasManualY ? Number(trendYMax) : null

      const chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "#ffffff" },
          textColor: "#475569",
          fontFamily: "Georgia, 'Noto Serif SC', 'Source Han Serif SC', serif",
          attributionLogo: true,
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: "#94a3b8",
            width: 1,
            labelBackgroundColor: "#2563eb",
          },
          horzLine: {
            color: "#cbd5e1",
            width: 1,
            labelBackgroundColor: "#0f172a",
          },
        },
        grid: {
          vertLines: { color: "#eef2ff", visible: true, style: 0 },
          horzLines: { color: "#f1f5f9", visible: true, style: 0 },
        },
        rightPriceScale: {
          borderColor: "#cbd5e1",
          scaleMargins: { top: 0.15, bottom: 0.12 },
        },
        timeScale: {
          borderColor: "#cbd5e1",
          barSpacing: 18,
          minBarSpacing: 6,
          rightOffset: 2,
          timeVisible: false,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: { time: true, price: true },
          axisDoubleClickReset: { time: true, price: true },
        },
      })

      chartApiRef.current = chart

      trendSeriesData.forEach((seriesConfig) => {
        const series = chart.addSeries(LineSeries, {
          color: seriesConfig.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          autoscaleInfoProvider: hasManualY && yMin !== null && yMax !== null
            ? () => ({
                priceRange: {
                  minValue: yMin,
                  maxValue: yMax,
                },
              })
            : undefined,
        })
        series.setData(seriesConfig.data)
      })

      if (trendStart && trendEnd) {
        chart.timeScale().setVisibleRange({ from: trendStart, to: trendEnd })
      } else {
        chart.timeScale().fitContent()
      }

      setPlotLoadError("")
    } catch (err) {
      console.error("Lightweight Charts render failed:", err)
      setPlotLoadError(err instanceof Error ? err.message : "趋势图渲染失败")
    }

    return () => {
      chartApiRef.current?.remove()
      chartApiRef.current = null
    }
  }, [manualYRange, trendEnd, trendSeriesData, trendStart, trendYMax, trendYMin])

  const handleQueryClick = async () => {
    await runQuery(selectedTableCn, filters)
  }

  const handleResetClick = async () => {
    if (!selectedTableCn) {
      return
    }
    setIsLoadingMeta(true)
    setError("")
    try {
      const response = await fetch(`/api/filter-meta?table_cn=${encodeURIComponent(selectedTableCn)}`)
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "重置失败：无法获取筛选项"))
      }
      const data = (await response.json()) as FilterMeta
      setMeta(data)
      const next = applyMetaDefaults(data)
      setFilters(next)
      await runQuery(selectedTableCn, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败")
    } finally {
      setIsLoadingMeta(false)
    }
  }

  const handleResetXAxis = () => {
    const minDate = dateValuesInRows[0] ?? ""
    const maxDate = dateValuesInRows[dateValuesInRows.length - 1] ?? ""
    setTrendStart(minDate)
    setTrendEnd(maxDate)

    const chart = chartApiRef.current
    if (!chart) {
      return
    }
    if (minDate && maxDate) {
      chart.timeScale().setVisibleRange({ from: minDate, to: maxDate })
    } else {
      chart.timeScale().fitContent()
    }
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
        </div>
      </div>

      {error ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm">{error}</span>
        </div>
      ) : null}

      <div
        className={
          filtersCollapsed
            ? "grid grid-cols-1 gap-6 lg:grid-cols-[72px_minmax(0,1fr)]"
            : "grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)]"
        }
      >
        <aside>
          {filtersCollapsed ? (
            <Card className="sticky top-4">
              <CardContent className="flex min-h-[180px] flex-col items-center justify-start gap-4 px-2 py-4">
                <Button variant="outline" size="sm" className="h-9 w-9 p-0" onClick={() => setFiltersCollapsed(false)} title="展开查询条件">
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground lg:[writing-mode:vertical-rl] lg:rotate-180">
                  <Filter className="h-4 w-4 lg:rotate-90" />
                  <span>查询条件</span>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="sticky top-4">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2">
                    <Filter className="h-5 w-5" /> 查询条件
                  </CardTitle>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => setFiltersCollapsed(true)} title="隐藏查询条件">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
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
                      {indicatorNameOptions.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="指标名称模糊查询（包含）"
                    value={filters.indicatorNameLike}
                    onChange={(event) => setFilters((prev) => ({ ...prev, indicatorNameLike: event.target.value }))}
                    disabled={isLoadingMeta || !meta}
                  />
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
                      {indicatorCodeOptions.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="指标代码模糊查询（包含）"
                    value={filters.indicatorCodeLike}
                    onChange={(event) => setFilters((prev) => ({ ...prev, indicatorCodeLike: event.target.value }))}
                    disabled={isLoadingMeta || !meta}
                  />
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
          )}
        </aside>

        <main className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>数据表</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="w-full max-w-xl">
                  <Label className="mb-1 block text-xs font-medium text-muted-foreground">数据表选择</Label>
                  <Select value={selectedTableCn} onValueChange={setSelectedTableCn} disabled={isLoadingTables || tables.length === 0}>
                    <SelectTrigger className="h-11 border-2 border-sky-300 bg-sky-50/70 font-semibold text-slate-800 shadow-sm hover:border-sky-400">
                      <SelectValue placeholder="请选择数据表（点击展开）" />
                    </SelectTrigger>
                    <SelectContent>
                      {tables.map((table) => (
                        <SelectItem key={table.cn} value={table.cn}>
                          {table.cn}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" onClick={() => void handleExportClick()} disabled={!result || result.row_count === 0}>
                  <Download className="h-4 w-4" /> 导出 CSV
                </Button>
              </div>
              <div className="relative h-[700px] min-h-[500px] max-h-[88vh] resize-y overflow-auto rounded-md border border-slate-300 bg-white">
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
              </div>
              <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-sm text-muted-foreground">
                  {result
                    ? `共 ${result.total_count.toLocaleString("zh-CN")} 条，当前显示 ${result.row_count.toLocaleString("zh-CN")} 条`
                    : "请先选择数据表"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">可拖拽数据表区域右下角，向下拉长显示更多行。</p>
              </div>
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
              <CardDescription>已切换为 TradingView Lightweight Charts，支持多指标同图、时间缩放和右侧价格轴缩放</CardDescription>
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

              <div className="grid grid-cols-1 gap-3 xl:grid-cols-6">
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
                <Button variant="secondary" onClick={handleResetXAxis}>
                  还原 X 轴
                </Button>
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

              <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2">
                {trendSeriesData.length > 0 ? (
                  trendSeriesData.map((series) => (
                    <div key={series.name} className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-xs text-slate-700 shadow-sm">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: series.color }} />
                      <span className="max-w-[220px] truncate">{series.name}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">请选择至少一个有数据的指标名称来显示趋势图。</div>
                )}
              </div>

              <div className="rounded-xl border bg-white/80 p-2">
                <div ref={plotContainerRef} className="h-[620px] w-full" />
                {plotLoadError ? (
                  <div className="mt-2 text-sm text-amber-700">趋势图组件加载失败: {plotLoadError}</div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  )
}
