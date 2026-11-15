import { useState } from "react";
import { observer } from "mobx-react-lite";
import { Alert, Button, Empty, Input, List, Space, Typography } from "antd";
import type { NotesStore } from "../stores/notes.store";

export interface OrderNotesPanelProps {
  store: NotesStore;
}

export const OrderNotesPanel = observer(function OrderNotesPanel({ store }: OrderNotesPanelProps) {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    await store.addNote(draft);
    if (store.error === null) setDraft("");
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Title level={5}>Notes ({store.count})</Typography.Title>
      {store.error && <Alert type="error" message={store.error} />}
      <Input.TextArea
        rows={3}
        value={draft}
        maxLength={1000}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add an internal note"
      />
      <Button type="primary" loading={store.saving} disabled={draft.trim() === ""} onClick={submit}>
        Add note
      </Button>
      <List
        loading={store.loading}
        dataSource={store.notes}
        locale={{ emptyText: <Empty description="No notes yet" /> }}
        renderItem={(note) => (
          <List.Item key={note.id}>
            <List.Item.Meta
              title={`${note.author} - ${new Date(note.createdAt).toLocaleDateString("en-GB")}`}
              description={note.text}
            />
          </List.Item>
        )}
      />
    </Space>
  );
});
