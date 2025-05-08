import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import {
  collection,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  onSnapshot
} from 'firebase/firestore';
import { useAuth } from '@clerk/clerk-react';
import Console from '../components/Console';

interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline';
  lastChecked?: number;
}

export default function Websites() {
  const { userId } = useAuth();
  const [websites, setWebsites] = useState<Website[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const log = (msg: string) => setLogs(lgs => [...lgs.slice(-98), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  const firstSnapshot = useRef(true);

  // Fetch websites from Firestore (real-time)
  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    const q = query(collection(db, 'websites'), where('userId', '==', userId));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      setWebsites(
        querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as Omit<Website, 'id'>)
        }))
      );

      // Only log added/removed after the first snapshot
      querySnapshot.docChanges().forEach(change => {
        const data = change.doc.data();
        const name = data.name || change.doc.id;
        if (change.type === "added" && !firstSnapshot.current) {
          log(`Website added: ${name}`);
        }
        if (change.type === "modified") {
          log(`Website updated: ${name} (status: ${data.status})`);
        }
        if (change.type === "removed" && !firstSnapshot.current) {
          log(`Website removed: ${name}`);
        }
      });

      firstSnapshot.current = false;
      setLoading(false);
    }, (err) => {
      log('Error with real-time updates: ' + err.message);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [userId]);

  // Countdown state for each website
  const [countdowns, setCountdowns] = useState<{ [id: string]: number }>({});

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(() => {
        const updated: { [id: string]: number } = {};
        websites.forEach(w => {
          const last = w.lastChecked || 0;
          const next = 60 - Math.floor((Date.now() - last) / 1000);
          updated[w.id] = next > 0 && next <= 60 ? next : 60;
        });
        return updated;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [websites]);

  const handleAddOrEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    if (editingId) {
      try {
        log(`Updating website: ${name} (${url})`);
        const ref = doc(db, 'websites', editingId);
        await updateDoc(ref, { name, url });
        setWebsites(ws => ws.map(w => w.id === editingId ? { ...w, name, url } : w));
        log('Website updated.');
      } catch (err) {
        log('Error updating website: ' + (err as Error).message);
      }
      setEditingId(null);
    } else {
      try {
        log(`Adding website: ${name} (${url})`);
        const docRef = await addDoc(collection(db, 'websites'), { name, url, userId });
        setWebsites(ws => [...ws, { id: docRef.id, name, url }]);
        log('Website added.');
      } catch (err) {
        log('Error adding website: ' + (err as Error).message);
      }
    }
    setName('');
    setUrl('');
  };

  const handleEdit = (website: Website) => {
    setEditingId(website.id);
    setName(website.name);
    setUrl(website.url);
  };

  const handleDelete = async (id: string) => {
    try {
      log('Deleting website...');
      await deleteDoc(doc(db, 'websites', id));
      setWebsites(ws => ws.filter(w => w.id !== id));
      log('Website deleted.');
    } catch (err) {
      log('Error deleting website: ' + (err as Error).message);
    }
  };

  return (
    <>
      <section className="flex flex-col items-center justify-center min-h-[60vh]">
        <h1 className="text-3xl font-bold mb-6 text-gray-800">Monitored Websites</h1>
        <form onSubmit={handleAddOrEdit} className="flex flex-col md:flex-row gap-4 mb-8 w-full max-w-2xl">
          <input
            type="text"
            className="flex-1 px-4 py-2 border rounded focus:outline-none focus:ring focus:border-blue-400"
            placeholder="Friendly name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
          <input
            type="url"
            className="flex-1 px-4 py-2 border rounded focus:outline-none focus:ring focus:border-blue-400"
            placeholder="https://example.com"
            value={url}
            onChange={e => setUrl(e.target.value)}
            required
          />
          <button
            type="submit"
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
          >
            {editingId ? 'Update' : 'Add'}
          </button>
        </form>
        {loading ? (
          <div className="text-gray-500 text-center">Loading...</div>
        ) : (
          <ul className="w-full max-w-2xl space-y-4">
            {websites.length === 0 && (
              <li className="text-gray-500 text-center">No websites added yet.</li>
            )}
            {websites.map(website => (
              <li key={website.id} className="flex flex-col md:flex-row items-center justify-between bg-white shadow rounded p-4">
                <div className="flex-1">
                  <div className="font-semibold text-lg text-gray-800 flex items-center gap-2">
                    {website.name}
                    {website.status && (
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${website.status === 'online' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {website.status === 'online' ? 'Online' : 'Offline'}
                      </span>
                    )}
                  </div>
                  <a href={website.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">{website.url}</a>
                  <div className="text-xs text-gray-500 mt-1">
                    Next check in: <span className="font-mono">{countdowns[website.id] ?? 60}s</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-2 md:mt-0">
                  <button
                    className="px-4 py-1 bg-yellow-400 text-white rounded hover:bg-yellow-500 transition"
                    onClick={() => handleEdit(website)}
                  >
                    Edit
                  </button>
                  <button
                    className="px-4 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition"
                    onClick={() => handleDelete(website.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Console logs={logs} />
    </>
  );
} 