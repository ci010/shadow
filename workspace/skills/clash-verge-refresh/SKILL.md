---
name: clash-verge-refresh
description: 刷新 Clash Verge 的 remote profile 订阅并重载配置。触发词：「刷新 Clash 订阅」、「更新代理节点」、「重载 Clash 配置」。
metadata:
  category: platform
---

# Clash Verge 订阅刷新

## 参数

- API 地址：`http://127.0.0.1:9097`
- Bearer Token：`123456789-x`
- Provider 名称：`节点组`
- 配置文件路径：`/Users/ci010/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml`

## 步骤

### 1. 刷新 proxy provider

```bash
curl -s -X PUT "http://127.0.0.1:9097/providers/proxies/节点组" \
  -H "Authorization: Bearer 123456789-x"
```

无输出为正常（HTTP 204）。

### 2. 等待 15 秒

```bash
sleep 15
# 若 sleep 不在 PATH，用 python3 替代：
python3 -c "import time; time.sleep(15)"
```

### 3. 重载配置

```bash
curl -s -X PUT "http://127.0.0.1:9097/configs?force=true" \
  -H "Authorization: Bearer 123456789-x" \
  -H "Content-Type: application/json" \
  -d '{"path":"/Users/ci010/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml","payload":""}'
```

### 4. 验证规则（前 5 条）

```bash
curl -s "http://127.0.0.1:9097/rules" \
  -H "Authorization: Bearer 123456789-x" \
  | python3 -c "import sys,json; rules=json.load(sys.stdin)['rules']; [print(r) for r in rules[:5]]"
```

期望：第 0/1 条为 `brave.com` 相关规则。

### 5. 查询节点数量

```bash
curl -s "http://127.0.0.1:9097/providers/proxies/节点组" \
  -H "Authorization: Bearer 123456789-x" \
  | python3 -c "import sys,json; data=json.load(sys.stdin); print(f'节点总数: {len(data.get(\"proxies\", []))}')"
```

## 报告格式

完成后回复：刷新结果（各步骤是否成功）、规则前 5 条、当前节点数量。
