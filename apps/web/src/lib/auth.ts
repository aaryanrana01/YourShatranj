import { create } from 'zustand';
import * as apiClient from './api';

type Status = 'loading' | 'guest' | 'authed';

interface AuthState {
  user: apiClient.SessionUser | null;
  status: Status;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => {
  apiClient.onSessionChange((user) => set({ user, status: user ? 'authed' : 'guest' }));
  return {
    user: null,
    status: 'loading',
    // On page load, the refresh cookie (if any) restores the session.
    init: async () => {
      const user = await apiClient.refreshSession();
      set({ user, status: user ? 'authed' : 'guest' });
    },
    login: async (username, password) => {
      await apiClient.login(username, password);
    },
    register: async (username, password) => {
      await apiClient.register(username, password);
    },
    logout: async () => {
      await apiClient.logout();
    },
  };
});
