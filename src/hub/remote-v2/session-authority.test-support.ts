import type { Principal } from '../contracts';
import { openHubStore } from '../store';

/** Change authority through the same transactional writer that maintains indexed sessions. */
export function editStoredPrincipal(dataDir: string, sessionDigest: string, change: (principal: Principal) => void) {
  const store = openHubStore(dataDir);
  try {
    store.writeTransaction(state => {
      const session = state.sessions[sessionDigest];
      if (!session) throw new Error('Missing authenticated fixture session');
      change(session.principal);
    });
  } finally { store.close(); }
}
