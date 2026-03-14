/**
 * ModelSelector — pill segmented control for choosing the AI model.
 * Props:
 *   value: 'claude' | 'kimi' | 'qwen'
 *   onChange: (model: string) => void
 *   compact: boolean  — smaller variant for use inside panels
 */

const MODELS = [
  {
    id: 'kimi',
    label: 'Kimi K2.5',
    shortLabel: 'Kimi',
    color: '#0ea5e9',
    bg: '#f0f9ff',
  },
  {
    id: 'qwen',
    label: 'Qwen 3.5',
    shortLabel: 'Qwen',
    color: '#9333ea',
    bg: '#faf5ff',
  },
  {
    id: 'glm',
    label: 'GLM-5',
    shortLabel: 'GLM',
    color: '#16a34a',
    bg: '#f0fdf4',
  },
]

export default function ModelSelector({ value, onChange, compact = false }) {
  return (
    <div className={`model-selector${compact ? ' model-selector--compact' : ''}`}>
      {MODELS.map((m) => {
        const active = value === m.id
        return (
          <button
            key={m.id}
            type="button"
            className={`model-selector-option${active ? ' active' : ''}`}
            style={active ? { background: m.color, borderColor: m.color, color: '#fff' } : {}}
            onClick={() => onChange(m.id)}
            aria-pressed={active}
          >
            {compact ? m.shortLabel : m.label}
          </button>
        )
      })}
    </div>
  )
}
