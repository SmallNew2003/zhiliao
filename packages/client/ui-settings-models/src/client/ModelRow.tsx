/** Shared model fields and actions for both adapter catalog editors. */

import { useId, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

const CONTEXT_WINDOW_PRESETS = ['320K', '640K', '960K']

/** Common presets stay visible; other capacities keep their exact value in the summary. */
function ContextWindowPresets({ input, position, disabled, t }: {
  input: CapacityInput
  position: number
  disabled: boolean
  t: (key: ModelsKey) => string
}): ReactNode {
  const groupName = useId()
  const isPreset = CONTEXT_WINDOW_PRESETS.includes(input.value)
  return (
    <fieldset className={styles['contextWindowField']} role="radiogroup" aria-label={`${t('contextWindowPreset')} ${String(position)}`}>
      <legend className={styles['modelFieldLabel']}>
        {t('contextWindow')}
        {!isPreset && input.value !== ''
          ? <span className={styles['contextWindowValue']} title={input.value}>{t('contextWindowCustom')} {input.value}</span>
          : null}
      </legend>
      <div className={styles['contextWindowChoices']}>
        {CONTEXT_WINDOW_PRESETS.map(value => (
          <label key={value} className={styles['contextWindowChoice']}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={input.value === value}
              disabled={disabled}
              onChange={() => {
                input.onChange(value)
              }}
            />
            <span>{value}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  expanded: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
}

/**
 * Render consistent model identity, capacity, and input-type controls.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one expandable model entry.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled } = props
  const advancedId = useId()
  return (
    <div className={styles['modelEntry']}>
      <div className={styles['modelRow']}>
        {(['id', 'name'] as const).map(field => (
          <input
            key={field}
            className={styles['input']}
            type="text"
            value={typeof model[field] === 'string' ? model[field] : ''}
            placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
            aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value
              props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
            }}
            onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
          />
        ))}
        <button
          type="button"
          className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <IconTrashOutline16 size={14} />
        </button>
      </div>
      <div className={styles['modelControls']}>
        <ContextWindowPresets input={props.contextWindow} position={position} disabled={disabled} t={t} />
        <button
          type="button"
          className={styles['modelAdvancedToggle']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          aria-controls={advancedId}
          onClick={props.onToggle}
        >
          {t('modelAdvanced')}
          {props.expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </button>
      </div>
      {props.expanded
        ? (
          <div id={advancedId} className={styles['modelAdvanced']}>
            <label className={styles['modelField']}>
              <span className={styles['modelFieldLabel']}>{t('contextWindowCustomInput')}</span>
              <input
                className={styles['input']}
                type="text"
                inputMode="numeric"
                value={props.contextWindow.value}
                placeholder={props.contextWindow.placeholder}
                aria-label={`${t('contextWindow')} ${String(position)}`}
                disabled={disabled}
                onChange={(event) => { props.contextWindow.onChange(event.target.value) }}
                onBlur={props.contextWindow.onBlur}
              />
            </label>
            <label className={styles['modelField']}>
              <span className={styles['modelFieldLabel']}>{t('maxTokens')}</span>
              <input
                className={styles['input']}
                type="text"
                inputMode="numeric"
                value={props.maxTokens.value}
                placeholder={props.maxTokens.placeholder}
                aria-label={`${t('maxTokens')} ${String(position)}`}
                disabled={disabled}
                onChange={(event) => { props.maxTokens.onChange(event.target.value) }}
                onBlur={props.maxTokens.onBlur}
              />
            </label>
            <ModelInputTypes
              model={model} field={props.inputField} position={position}
              fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange}
            />
          </div>
        )
        : null}
    </div>
  )
}
