import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import type { NoteDto, NotesApi } from "../api/notes.api";
import { NotesStore } from "../stores/notes.store";
import { OrderNotesPanel } from "./OrderNotesPanel";

const NOTES: NoteDto[] = [
  {
    id: "n-2",
    orderId: "o-1001",
    text: "Customer asked to leave the parcel with the neighbour.",
    author: "support-1",
    createdAt: "2026-10-13T10:15:00Z",
  },
  {
    id: "n-1",
    orderId: "o-1001",
    text: "Address confirmed by phone.",
    author: "support-2",
    createdAt: "2026-10-12T16:40:00Z",
  },
];

function fakeApi(overrides: Partial<NotesApi> = {}): NotesApi {
  return {
    listNotes: async () => NOTES,
    addNote: async (orderId, text) => ({
      id: "n-new",
      orderId,
      text,
      author: "support-1",
      createdAt: "2026-10-14T09:00:00Z",
    }),
    ...overrides,
  };
}

interface PanelDemoProps {
  api: NotesApi;
}

function PanelDemo({ api }: PanelDemoProps) {
  const [store] = useState(() => new NotesStore(api, "o-1001"));

  useEffect(() => {
    store.onMount();
    return () => store.onUnmount();
  }, [store]);

  return <OrderNotesPanel store={store} />;
}

const meta: Meta<typeof PanelDemo> = {
  title: "Components/OrderNotesPanel",
  component: PanelDemo,
};

export default meta;
type Story = StoryObj<typeof PanelDemo>;

export const Default: Story = {
  args: { api: fakeApi() },
};

export const Empty: Story = {
  args: { api: fakeApi({ listNotes: async () => [] }) },
};

export const Loading: Story = {
  args: { api: fakeApi({ listNotes: () => new Promise<NoteDto[]>(() => {}) }) },
};

export const LoadError: Story = {
  args: {
    api: fakeApi({
      listNotes: async () => {
        throw new Error("Notes service is unavailable");
      },
    }),
  },
};
