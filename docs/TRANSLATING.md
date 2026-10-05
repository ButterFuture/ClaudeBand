# Translating ClaudeBand

> **中文简介：** 新增一种语言只需要：复制 `hooks/locales/en.ts` 为 `<语言代码>.ts` 并翻译；在 `hooks/locales/index.ts` 和 `.claude-plugin/plugin.json` 各加一处；跑一遍类型检查和测试；提 PR 时用 **translation** 模板。README 翻译可选。下面是完整步骤（英文）。

Thank you for helping! A new language takes one file of strings and two one-line registrations. No other code changes.

## 1. Add the strings

Copy the English file and name it after your language's code (`ja`, `ko`, `es`, `zh-TW`, `pt-BR`…):

```bash
cp hooks/locales/en.ts hooks/locales/ja.ts
```

Then translate every value in it. The fields, and what each one is for, are documented in [`hooks/locales/types.ts`](../hooks/locales/types.ts). A few notes:

- **`code`** is the code above; **`name`** is your language's name in itself (`日本語`, not `Japanese`).
- **`match`** is a regular expression for recognising your language in Claude Code's `language` setting or in `LANG`: `/^ja|japanese|日本語/i`.
- **Functions return whole phrases**, so put the pieces in the order your language needs: `resetsIn: span => \`${span}後にリセット\``.
- **Keep labels short.** `labels` sit side by side on one line above the prompt, and `spendBrief` shares that line; the longer they are, the sooner the spend group hides on narrow windows.
- **`span`** formats a length of time from days, hours and minutes (`d` is 0 when the time is under a day).

## 2. Register it

In [`hooks/locales/index.ts`](../hooks/locales/index.ts), import the file and add it to `LOCALES`:

```ts
import ja from './ja'

export const LOCALES: Record<string, Locale> = { zh, en, ja }
```

In [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json), add the code to the `language` option's `options`, so `/config` and `/cb lang` accept it:

```json
"options": ["auto", "zh", "en", "ja"]
```

## 3. Check it

```bash
npx -p typescript@5 tsc -p .                               # a missing or misspelt field fails here
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .   # includes "every language file fills the whole contract"
```

Then try it for real: point Claude Code at your checkout (see the README's Install), run `/reload-plugins` and `/cb lang ja`, and look at the band above the prompt, its opened rows, and `/cb`'s pane in both Rings and Bars. Text that runs past a ring or crowds the band is worth shortening.

## 4. Optional: the README

Copy `README.en.md` to `README.<code>.md`, translate it, and add your language to the switcher line at the top of every README (`[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)`). Screenshots can stay the English ones (`docs/en/…`); maintainers can render `docs/<code>/` for you.

## 5. Open the pull request

Use the **translation** template (add `?template=translation.md` to the compare URL, or copy [`.github/PULL_REQUEST_TEMPLATE/translation.md`](../.github/PULL_REQUEST_TEMPLATE/translation.md)); its checklist is the steps above. One language per pull request keeps review easy. Fixes to an existing translation are just as welcome: edit the file and say what read wrong.
