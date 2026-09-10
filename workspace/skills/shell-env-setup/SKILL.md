---
name: shell-env-setup
description: "General principle: when any CLI tool or runtime requires repeated environment initialization (nvm, pyenv, virtualenv, conda, source activate, etc.), write the PATH/env vars to .env immediately. This avoids repeating boilerplate in every shell command and saves tokens."
metadata:
  category: setup
---

# Shell 环境变量配置原则

## 核心原则

**遇到任何需要重复初始化的环境命令，第一时间写入工作区 `.env` 文件。**

工作区 `.env` 中的变量会自动注入到每个子进程，无需在每条命令里重复。

## 操作步骤

1. 第一次运行时，用完整命令找到工具的实际路径（`which node`、`which python` 等）
2. 将路径追加到 `.env` 的 `PATH` 行
3. 验证：直接运行命令，不加任何初始化前缀

## 反思时机

每次发现自己在命令前加 `source`、`nvm use`、`activate` 等前缀时，停下来问：
> 这个能不能写进 `.env` 一劳永逸？
