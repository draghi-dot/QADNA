/**
 * ChatPanel — sliding right-side AI chat panel.
 * Props:
 *   repoId:   string | null  — cloned repo id, used as auditId for chat context
 *   repoName: string         — display name for the initial greeting
 */

import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Chat bubble SVG icon ────────────────────────────────────────────────────

function ChatIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ─── Message bubble ──────────────────────────────────────────────────────────

function MessageBubble({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`chat-message ${isUser ? 'chat-message--user' : 'chat-message--ai'}`}>
      {!isUser && (
        <div className="chat-message-avatar">AI</div>
      )}
      <div className="chat-message-bubble">
        {message.content}
        {message.streaming && <span className="chat-cursor">|</span>}
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ChatPanel({ repoId, repoName }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const abortRef = useRef(null)

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Set initial message when repoId/repoName changes
  useEffect(() => {
    const initialMsg = repoId
      ? `Repository **${repoName || repoId}** is ready. Run a security audit or open the Visual Map, then ask me anything about this codebase.`
      : 'Clone a repository first and I\'ll help you understand the codebase.'

    setMessages([{
      id: 'init',
      role: 'assistant',
      content: initialMsg,
    }])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId])

  const sendMessage = useCallback(async () => {
    const text = inputText.trim()
    if (!text || isStreaming) return

    const userMsg = { id: crypto.randomUUID(), role: 'user', content: text }
    const aiMsgId = crypto.randomUUID()
    const aiMsg   = { id: aiMsgId, role: 'assistant', content: '', streaming: true }

    setMessages(prev => [...prev, userMsg, aiMsg])
    setInputText('')
    setIsStreaming(true)

    const historyMessages = [...messages, userMsg]
      .filter(m => m.id !== 'init')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

    try {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyMessages,
          auditId: repoId || undefined,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulatedText = ''

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const event = JSON.parse(data)
            if (event.type === 'delta' && event.text) {
              accumulatedText += event.text
              const currentText = accumulatedText
              setMessages(prev => prev.map(m =>
                m.id === aiMsgId ? { ...m, content: currentText } : m
              ))
            } else if (event.type === 'done' || event.type === 'error') {
              break
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }

      setMessages(prev => prev.map(m =>
        m.id === aiMsgId ? { ...m, streaming: false } : m
      ))
    } catch (err) {
      if (err.name === 'AbortError') return

      setMessages(prev => prev.map(m =>
        m.id === aiMsgId
          ? { ...m, content: `Sorry, I encountered an error: ${err.message}`, streaming: false }
          : m
      ))
    } finally {
      setIsStreaming(false)
    }
  }, [inputText, isStreaming, messages, repoId])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const generateDocs = useCallback(async () => {
    if (!repoId || isStreaming) return

    const userMsg = { id: crypto.randomUUID(), role: 'user', content: 'Generate documentation for this repository' }
    const aiMsgId = crypto.randomUUID()
    const aiMsg   = { id: aiMsgId, role: 'assistant', content: '', streaming: true }

    setMessages(prev => [...prev, userMsg, aiMsg])
    setIsStreaming(true)

    try {
      const res = await fetch('/api/audit/generate-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId: repoId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === 'delta') {
              accumulated += ev.text
              const text = accumulated
              setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, content: text } : m))
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId ? { ...m, content: `Failed to generate docs: ${err.message}`, streaming: false } : m
      ))
    } finally {
      setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, streaming: false } : m))
      setIsStreaming(false)
    }
  }, [repoId, isStreaming])

  const handleToggle = () => {
    setOpen(o => !o)
    if (!open) {
      setTimeout(() => inputRef.current?.focus(), 280)
    }
  }

  return (
    <>
      {/* Toggle button — always visible on right edge */}
      <button
        className={`chat-toggle-btn${open ? ' chat-toggle-btn--open' : ''}`}
        type="button"
        onClick={handleToggle}
        aria-label={open ? 'Close chat' : 'Open CodeAtlas AI chat'}
      >
        <ChatIcon size={15} />
        {!open && <span className="chat-toggle-label">AI</span>}
      </button>

      {/* Sliding panel */}
      <div className={`chat-panel${open ? ' open' : ''}`} role="dialog" aria-label="CodeAtlas AI chat">
        {/* Header */}
        <div className="chat-panel-header">
          <div className="chat-panel-title">
            <div className="chat-panel-title-icon">
              <ChatIcon size={12} />
            </div>
            <span>CodeAtlas AI</span>
          </div>
        </div>

        {/* Quick actions */}
        {repoId && (
          <div style={{ padding: '7px 12px', borderBottom: '1px solid rgba(0,0,0,0.07)', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={generateDocs}
              disabled={isStreaming}
              style={{
                padding: '4px 10px', borderRadius: 100, fontSize: 11, fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                background: isStreaming ? 'rgba(0,0,0,0.03)' : 'rgba(26,107,255,0.08)',
                border: '1px solid rgba(26,107,255,0.2)',
                color: isStreaming ? '#94a3b8' : '#1a6bff',
                cursor: isStreaming ? 'not-allowed' : 'pointer',
                letterSpacing: '0.01em',
              }}
            >
              Generate docs
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="chat-input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={repoId ? 'Ask about this codebase...' : 'Clone a repo first...'}
            rows={2}
            disabled={isStreaming}
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={sendMessage}
            disabled={isStreaming || !inputText.trim()}
            aria-label="Send message"
          >
            {isStreaming ? (
              <span className="chat-send-spinner" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <line x1="22" y1="2" x2="11" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Backdrop — close on click outside */}
      {open && (
        <div
          className="chat-backdrop"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
    </>
  )
}
