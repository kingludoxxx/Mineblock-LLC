import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';

export function useWorkspace() {
  const [workspace, setWorkspace] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchWorkspace = useCallback(async () => {
    try {
      const res = await api.get('/workspace', { withCredentials: true });
      setWorkspace(res.data.workspace || res.data);
    } catch {
      setWorkspace(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkspace();
  }, [fetchWorkspace]);

  const updateWorkspace = async (data) => {
    const res = await api.put('/workspace', data, { withCredentials: true });
    setWorkspace(res.data.workspace || res.data);
    return res.data;
  };

  return {
    workspace,
    isLoading,
    fetchWorkspace,
    updateWorkspace,
  };
}
