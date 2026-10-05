## Language

<!-- e.g. 日本語 (ja) -->

## Checklist

- [ ] `hooks/locales/<code>.ts`, every value translated (`code`, `name`, `match` included)
- [ ] added to `LOCALES` in `hooks/locales/index.ts`
- [ ] code added to the `language` options in `.claude-plugin/plugin.json`
- [ ] `npx -p typescript@5 tsc -p .` passes
- [ ] `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` passes
- [ ] tried with `/cb lang <code>`: the band, its opened rows, and the `/cb` pane (Rings and Bars)
- [ ] (optional) `README.<code>.md`, and the language switcher in every README

## Notes for reviewers

<!-- Words you were unsure of, places where text felt cramped, screenshots welcome. -->
