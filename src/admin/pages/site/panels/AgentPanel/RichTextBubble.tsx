/**
 * RichTextBubble — renders a message text block with inline clickable
 * layer-mention pills. User messages use stored mentions; assistant messages
 * are scanned for mention patterns and validated against the current page.
 * Text without mentions falls back to markdown rendering (bold, lists, code).
 */
import { memo, useCallback } from 'react'
import { useEditorStore } from '@site/store/store'
import { renderMarkdownToHtml } from '@site/agent'
import { cn } from '@ui/cn'
import type { AgentMessageMention } from '@site/agent'
import styles from './AgentPanel.module.css'

interface RichTextBubbleProps {
  text: string
  isUser: boolean
  mentions?: AgentMessageMention[]
}

const MENTION_RE = /\bLayer(s?)\s+([A-Za-z0-9_-]+(?:,\s*[A-Za-z0-9_-]+)*)\b/g

function useNodeSelector() {
  const selectNode = useCallback(
    (nodeId: string) => {
      try {
        useEditorStore.getState().selectNode(nodeId, 'replace')
      } catch {
        // Content workspace or missing store — silently ignore.
      }
    },
    [],
  )
  return selectNode
}

function MentionPill({ label, nodeId }: { label: string; nodeId: string }) {
  const selectNode = useNodeSelector()
  return (
    <span
      className={styles.mentionPill}
      data-node-id={nodeId}
      onClick={(e) => {
        e.stopPropagation()
        selectNode(nodeId)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          selectNode(nodeId)
        }
      }}
    >
      {label}
    </span>
  )
}

/**
 * Split text by a set of known mention labels and render each mention as a
 * clickable pill. Unmatched text is rendered as a plain <span>.
 */
function renderWithStoredMentions(
  text: string,
  mentions: AgentMessageMention[],
): React.ReactNode[] {
  const segments: React.ReactNode[] = []
  let remaining = text

  for (const mention of mentions) {
    const idx = remaining.indexOf(mention.label)
    if (idx === -1) continue
    if (idx > 0) {
      segments.push(
        <span key={`t-${segments.length}`}>{remaining.slice(0, idx)}</span>,
      )
    }
    segments.push(
      <MentionPill
        key={`m-${mention.nodeId}-${segments.length}`}
        nodeId={mention.nodeId}
        label={mention.label}
      />,
    )
    remaining = remaining.slice(idx + mention.label.length)
  }

  if (remaining) {
    segments.push(<span key={`t-${segments.length}`}>{remaining}</span>)
  }

  return segments.length > 0 ? segments : [text]
}

/**
 * Scan assistant text for "Layer abc123" or "Layers abc123, def456" patterns
 * and render matching nodeIds as pills. All other text stays plain.
 */
function renderWithScannedMentions(text: string): React.ReactNode[] {
  const segments: React.ReactNode[] = []
  let lastIndex = 0

  // Get current page node ids for validation
  let validNodeIds: Set<string> | null = null
  try {
    const site = useEditorStore.getState().site
    const activePageId = useEditorStore.getState().activePageId
    const page = site?.pages.find((p) => p.id === activePageId)
    if (page?.nodes) {
      validNodeIds = new Set(Object.keys(page.nodes))
    }
  } catch {
    // No editor store available (content workspace)
  }

  let match: RegExpExecArray | null
  MENTION_RE.lastIndex = 0
  while ((match = MENTION_RE.exec(text)) !== null) {
    const [fullMatch, plural, idsStr] = match
    const start = match.index
    const ids = idsStr.split(',').map((s) => s.trim())

    // Push plain text before the match
    if (start > lastIndex) {
      segments.push(
        <span key={`t-${segments.length}`}>{text.slice(lastIndex, start)}</span>,
      )
    }

    // Render each id as a pill if it looks valid
    const pills: React.ReactNode[] = []
    ids.forEach((id, i) => {
      const isValid = !validNodeIds || validNodeIds.has(id)
      if (isValid) {
        pills.push(
          <MentionPill
            key={`m-${id}-${segments.length}-${i}`}
            nodeId={id}
            label={`Layer ${id}`}
          />,
        )
      } else {
        pills.push(
          <span key={`m-${id}-${segments.length}-${i}`}>Layer {id}</span>,
        )
      }
      if (i < ids.length - 1) {
        pills.push(<span key={`sep-${segments.length}-${i}`}>, </span>)
      }
    })

    // Wrap the group with the "Layers" prefix if plural
    if (plural && ids.length > 1) {
      segments.push(
        <span key={`g-${segments.length}`}>
          Layers {pills}
        </span>,
      )
    } else if (plural && ids.length === 1) {
      segments.push(
        <span key={`g-${segments.length}`}>
          Layers {pills}
        </span>,
      )
    } else {
      segments.push(
        <span key={`g-${segments.length}`}>
          Layer {pills}
        </span>,
      )
    }

    lastIndex = start + fullMatch.length
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push(<span key={`t-${segments.length}`}>{text.slice(lastIndex)}</span>)
  }

  return segments.length > 0 ? segments : [text]
}

// Exception: React.memo re-render bailout on a hot, list-rendered component.
const RichTextBubble = memo(function RichTextBubble({
  text,
  isUser,
  mentions,
}: RichTextBubbleProps) {
  const hasStoredMentions = mentions && mentions.length > 0

  if (hasStoredMentions) {
    return (
      <div
        className={cn(
          styles.messageText,
          isUser ? styles.messageTextUser : styles.messageTextAssistant,
        )}
      >
        {renderWithStoredMentions(text, mentions!)}
      </div>
    )
  }

  // Assistant text — scan for mention patterns
  if (!isUser && MENTION_RE.test(text)) {
    // Reset regex state after test
    MENTION_RE.lastIndex = 0
    return (
      <div
        className={cn(
          styles.messageText,
          styles.messageTextAssistant,
        )}
      >
        {renderWithScannedMentions(text)}
      </div>
    )
  }
  MENTION_RE.lastIndex = 0

  // No mentions — render markdown for assistants, plain text for users
  const html = !isUser ? renderMarkdownToHtml(text) : null
  if (html) {
    return (
      <div
        className={cn(
          styles.messageText,
          styles.messageTextAssistant,
          styles.markdownText,
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <div
      className={cn(
        styles.messageText,
        isUser ? styles.messageTextUser : styles.messageTextAssistant,
      )}
    >
      {text}
    </div>
  )
})

export { RichTextBubble }
