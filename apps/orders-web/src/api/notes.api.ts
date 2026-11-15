import { http } from "./http";

export interface NoteDto {
  id: string;
  orderId: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface NotesApi {
  listNotes(orderId: string): Promise<NoteDto[]>;
  addNote(orderId: string, text: string): Promise<NoteDto>;
}

export const notesApi: NotesApi = {
  async listNotes(orderId) {
    const res = await http.get<NoteDto[]>(`/orders/${encodeURIComponent(orderId)}/notes`);
    return res.data;
  },
  async addNote(orderId, text) {
    const res = await http.post<NoteDto>(`/orders/${encodeURIComponent(orderId)}/notes`, { text });
    return res.data;
  },
};
