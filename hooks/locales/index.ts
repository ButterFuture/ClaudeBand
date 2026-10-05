// Every language the plugin speaks. Adding one takes three lines: the import, its entry
// in LOCALES, and its code in .claude-plugin/plugin.json's `language` options.
import type { Locale } from './types'
import en from './en'
import zh from './zh'

export type { Locale }

export const LOCALES: Record<string, Locale> = { zh, en }

/** when nothing says which language: the settings are silent and LANG is unset */
export const FALLBACK = zh

/** the language a setting or a locale variable names, if any file claims it */
export const matchLocale = (text: unknown): Locale | undefined =>
  typeof text === 'string' && text !== '' ? Object.values(LOCALES).find(one => one.match.test(text)) : undefined
