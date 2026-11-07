import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TimelineEntry } from './session-timeline';

type EntryView = { id: string; entry: TimelineEntry };
const RenderEntry = createContext<(entry: TimelineEntry) => ReactNode>(() => null);

function toMessage({ id, entry }: EntryView): ThreadMessageLike {
  if (entry.kind === 'outcome') return { id, role: 'system', content: '/' + entry.item.outcome.commandName };
  if (entry.kind === 'delivery') return { id, role: 'user', content: entry.delivery.text, createdAt: new Date(entry.delivery.submittedAt) };
  const { role, text, createdAt } = entry.message;
  return {
    id,
    role: role === 'human' ? 'user' : role === 'assistant' ? 'assistant' : 'system',
    content: text,
    createdAt: new Date(createdAt),
  };
}

const Entries = createContext<ReadonlyMap<string, TimelineEntry>>(new Map());

function TimelineMessage() {
  const id = useAuiState(state => state.message.id);
  const entry = useContext(Entries).get(id);
  const renderEntry = useContext(RenderEntry);
  return entry ? <MessagePrimitive.Root asChild>{renderEntry(entry)}</MessagePrimitive.Root> : null;
}

/** Hub remains the source of truth for messages, receipts and the versioned composer. */
export function SessionTranscript({
  entries,
  renderEntry,
  children,
}: {
  entries: TimelineEntry[];
  renderEntry: (entry: TimelineEntry) => ReactNode;
  children: ReactNode;
}) {
  const views = useMemo(() => entries.map(entry => ({
    entry,
    id: entry.kind === 'outcome' ? 'command:' + entry.item.outcome.operationId
      : entry.kind === 'delivery' ? 'delivery:' + entry.delivery.operationId
        : entry.delivery ? 'delivery:' + entry.delivery.operationId : 'message:' + entry.message.messageId,
  })), [entries]);
  const indexed = useMemo(() => new Map(views.map(view => [view.id, view.entry])), [views]);
  const runtime = useExternalStoreRuntime({
    messages: views,
    convertMessage: toMessage,
    isDisabled: true,
    onNew: async () => { throw new Error("Submit through the Hub session composer"); },
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <Entries.Provider value={indexed}>
      <RenderEntry.Provider value={renderEntry}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Viewport className="session-transcript-body">
            <ol className="session-thread"><ThreadPrimitive.Messages components={{ Message: TimelineMessage }} /></ol>
            {children}
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </RenderEntry.Provider>
    </Entries.Provider>
  </AssistantRuntimeProvider>;
}
