import { useCallback, useEffect, useState } from 'react';

const EVENT_NAME = 'local-storage-change';

type LocalStorageChangeDetail = { key: string; value: unknown };

export function useLocalStorage<T>(key: string, initialValue: T) {
  const readValue = useCallback((): T => {
    if (typeof window === 'undefined') return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  }, [key, initialValue]);

  const [storedValue, setStoredValue] = useState<T>(readValue);

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const valueToStore =
          value instanceof Function ? value(storedValue) : value;
        setStoredValue(valueToStore);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
          window.dispatchEvent(
            new CustomEvent<LocalStorageChangeDetail>(EVENT_NAME, {
              detail: { key, value: valueToStore },
            })
          );
        }
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, storedValue]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<LocalStorageChangeDetail>).detail;
      if (!detail || detail.key !== key) return;
      setStoredValue(detail.value as T);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      try {
        setStoredValue(
          event.newValue ? (JSON.parse(event.newValue) as T) : initialValue
        );
      } catch (error) {
        console.error(`Error parsing localStorage key "${key}":`, error);
      }
    };

    window.addEventListener(EVENT_NAME, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, [key, initialValue]);

  return [storedValue, setValue] as const;
}
