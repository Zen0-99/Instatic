/**
 * AgentComposer — a contenteditable chat input that supports clickable
 * layer-mention pills. Mentions render as bold coloured inline text (e.g.
 * ".icon" or "<header>"). On submit the human text is stored for UI
 * display, but `sendAgentMessage` replaces each mention label with
 * "Layer <nodeId>" in the prompt sent to the AI so the model understands
 * these are layer references and can respond with machine-readable ids.
 */
import { useRef, useEffect, useCallback } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useEditorStore } from '@site/store/store'
import { cn } from '@ui/cn'
import { pillAccent, pillAccentVar } from '@ui/pillAccent'
import { getMentionLabelForNode } from '@site/agent/mentionLabel'
import styles from './AgentPanel.module.css'

import type { AgentDraftMention } from '@site/agent'

interface AgentComposerProps {
  placeholder?: string
  disabled?: boolean
  onSubmit: (text: string, mentions: AgentDraftMention[]) => void
}

export function AgentComposer({ placeholder, disabled, onSubmit }: AgentComposerProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const draftMentions = useAgentStore((s) => s.agentDraftMentions)
  const clearMentions = useAgentStore((s) => s.clearAgentDraftMentions)

  // Consume queued mentions from the store and insert them into the editor.
  useEffect(() => {
    if (draftMentions.length === 0 || !editorRef.current) return
    const el = editorRef.current
    el.focus()

    const sel = window.getSelection()
    const hasSelection =
      sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)

    for (const mention of draftMentions) {
      const { label, colorKey } = getMentionLabelForNode(mention.nodeId)
      const pill = document.createElement('span')
      pill.className = styles.mentionPill
      pill.dataset.nodeId = mention.nodeId
      pill.contentEditable = 'false'
      pill.textContent = label
      pill.style.color = pillAccentVar(pillAccent(colorKey))

      const space = document.createTextNode('\u00A0')

      if (hasSelection) {
        const range = sel!.getRangeAt(0)
        range.deleteContents()
        range.insertNode(space)
        range.collapse(false)
        range.insertNode(pill)
        range.collapse(false)
      } else {
        el.appendChild(pill)
        el.appendChild(space)
      }
    }

    // Move caret to end
    const endRange = document.createRange()
    endRange.selectNodeContents(el)
    endRange.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(endRange)

    // Update empty-state styling
    const isEmpty = el.innerText.trim() === ''
    el.classList.toggle(styles.composerEmpty, isEmpty)

    clearMentions()
  }, [draftMentions, clearMentions])

  const handleInput = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const isEmpty = el.innerText.trim() === ''
    el.classList.toggle(styles.composerEmpty, isEmpty)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const el = editorRef.current
        if (!el) return
        const text = el.innerText.trim()
        if (text) {
          // Collect mention pills before we wipe the DOM.
          const mentions: AgentDraftMention[] = []
          el.querySelectorAll('[data-node-id]').forEach((node) => {
            const nodeId = node.getAttribute('data-node-id')
            if (nodeId) {
              mentions.push({ nodeId, label: node.textContent || `Layer ${nodeId}` })
            }
          })
          onSubmit(text, mentions)
          el.innerHTML = ''
          el.classList.add(styles.composerEmpty)
        }
      }
    },
    [onSubmit],
  )

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const plain = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, plain)
  }, [])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const nodeId = target.dataset.nodeId
    if (nodeId) {
      e.preventDefault()
      e.stopPropagation()
      useEditorStore.getState().selectNode(nodeId, 'replace')
    }
  }, [])

  return (
    <div
      ref={editorRef}
      className={cn(styles.composer, styles.composerEmpty, disabled && styles.composerDisabled)}
      contentEditable={!disabled}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onClick={handleClick}
      data-placeholder={placeholder}
      suppressContentEditableWarning
      aria-label={placeholder}
      role="textbox"
    />
  )
}
