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

export type ChatTranscriptEntry = {
  message: ThreadMessageLike & { id: string };
  render: () => ReactNode;
};

function toMessage({ message }: ChatTranscriptEntry): ThreadMessageLike {
  return message;
}

const Entries = createContext<ReadonlyMap<string, ChatTranscriptEntry>>(new Map());

function TranscriptMessage() {
  const id = useAuiState(state => state.message.id);
  const entry = useContext(Entries).get(id);
  return entry ? <MessagePrimitive.Root asChild>{entry.render()}</MessagePrimitive.Root> : null;
}

export function ChatTranscript({ entries, children }: { entries: ChatTranscriptEntry[]; children?: ReactNode }) {
  const indexed = useMemo(() => new Map(entries.map(entry => [entry.message.id, entry])), [entries]);
  const runtime = useExternalStoreRuntime({
    messages: entries,
    convertMessage: toMessage,
    isDisabled: true,
    onNew: async () => { throw new Error("Submit through the Hub session composer"); },
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <Entries.Provider value={indexed}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport className="session-transcript-body">
          <ol className="session-thread"><ThreadPrimitive.Messages components={{ Message: TranscriptMessage }} /></ol>
          {children}
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </Entries.Provider>
  </AssistantRuntimeProvider>;
}

function sessionMessage(entry: TimelineEntry): ChatTranscriptEntry["message"] {
  if (entry.kind === 'outcome') {
    return { id: 'command:' + entry.item.outcome.operationId, role: 'system', content: '/' + entry.item.outcome.commandName };
  }
  if (entry.kind === 'delivery') {
    return {
      id: 'delivery:' + entry.delivery.operationId, role: 'user', content: entry.delivery.text,
      createdAt: new Date(entry.delivery.submittedAt),
    };
  }
  const { role, text, createdAt, messageId } = entry.message;
  return {
    id: entry.delivery ? 'delivery:' + entry.delivery.operationId : 'message:' + messageId,
    role: role === 'human' ? 'user' : role === 'assistant' ? 'assistant' : 'system',
    content: text,
    createdAt: new Date(createdAt),
  };
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
  const views = entries.map(entry => ({ message: sessionMessage(entry), render: () => renderEntry(entry) }));
  return <ChatTranscript entries={views}>{children}</ChatTranscript>;
}
