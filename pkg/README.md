# pkg - Futures Dashboard (React + shadcn/ui)

期货数据可视化网站，采用 `React + shadcn/ui + FastAPI + MySQL`。

## 功能

- 六张表切换展示：补充 / 仓单 / 黑色 / 农油 / 全量 / 有色
- 左侧筛选（基于当前表）：
  - 指标名称（下拉）
  - 指标代码（下拉）
  - 日期范围
  - 数值范围
  - `查询` / `重置`
- 右侧展示：
  - 数据表选择（默认全量）
  - 查询结果
  - 数据表
  - 数值统计（平均值、最小值、最大值、中位数、标准差）
  - 趋势图（支持指标多选；支持 X 轴与手动 Y 轴范围）
- 导出 CSV（按当前筛选结果）

## 数据字段

数据表只显示以下字段：

- `indicator code`
- `indicator name`
- `value`
- `unit`
- `frequency`
- `datetime`

## 启动

```bash
cd /Users/shaobin/Desktop/code/gangliandata/pkg
cp .env.example .env   # 首次可执行，已有可跳过
./start.sh
```

访问：`http://localhost:8502`

## 一键启停脚本

```bash
/Users/shaobin/Desktop/code/runrun/pkg/start.sh
/Users/shaobin/Desktop/code/runrun/pkg/stop.sh
```

这两个脚本仅针对本项目 `http://localhost:8502`，不会主动停止其它端口服务。

## 环境变量

`.env` 示例：

```env
DB_HOST=10.10.10.120
DB_PORT=3306
DB_USER=root
DB_PASSWORD=eiNg6pie
DB_NAME=futures
APP_PORT=8502
```
