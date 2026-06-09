'use client';

import { useState, useEffect, Suspense, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import RealtimeKitClient from '@cloudflare/realtimekit';
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit';

interface ParticipantState {
  id: string;
  name: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  videoEnabled: boolean;
  audioEnabled: boolean;
  isScreenShare: boolean;
}

interface MeetingState {
  meeting: ReturnType<typeof RealtimeKitClient.init> extends Promise<infer T> ? T : never;
  self: ParticipantState;
  participants: ParticipantState[];
}

function ParticipantVideo({ track, name, isMuted }: { track?: MediaStreamTrack; name: string; isMuted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && track) {
      videoRef.current.srcObject = new MediaStream([track]);
    }
  }, [track]);

  if (!track) {
    return (
      <div className="w-full h-full bg-gray-800 flex items-center justify-center">
        <div className="w-16 h-16 rounded-full bg-gray-600 flex items-center justify-center text-2xl text-white font-bold">
          {name.charAt(0).toUpperCase()}
        </div>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={isMuted}
      className="w-full h-full object-cover"
    />
  );
}

function ParticipantGrid({ localParticipant, remoteParticipants }: {
  localParticipant: ParticipantState;
  remoteParticipants: ParticipantState[];
}) {
  // Filter out any remote participant that has the same ID as local
  const filteredRemote = remoteParticipants.filter(
    (p) => p.id !== localParticipant.id
  );
  const allParticipants = [localParticipant, ...filteredRemote];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 p-4">
      {allParticipants.map((p, idx) => (
        <div key={p.id} className="relative aspect-video bg-gray-900 rounded-lg overflow-hidden">
          <ParticipantVideo
            track={p.videoTrack}
            name={p.name}
            isMuted={idx === 0}
          />
          <div className="absolute bottom-2 left-2 bg-black/60 px-2 py-1 rounded text-white text-xs">
            {idx === 0 ? 'You' : p.name}
          </div>
          {p.audioEnabled === false && (
            <div className="absolute top-2 right-2">🔇</div>
          )}
        </div>
      ))}
    </div>
  );
}

function MeetingContent({ initialMeetingId }: { initialMeetingId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState(initialMeetingId);
  const [localParticipant, setLocalParticipant] = useState<ParticipantState>({
    id: 'local',
    name: 'You',
    videoEnabled: true,
    audioEnabled: true,
    isScreenShare: false,
  });
  const [remoteParticipants, setRemoteParticipants] = useState<ParticipantState[]>([]);
  const meetingRef = useRef<MeetingState['meeting'] | null>(null);
  const isMountedRef = useRef(true);
  // Use a Map to track participants by ID to avoid duplicates
  const participantsMapRef = useRef(new Map<string, ParticipantState>());

  const updateSelfState = useCallback((self: RTKSelf) => {
    if (!isMountedRef.current) return;
    setLocalParticipant({
      id: self.id,
      name: 'You',
      videoTrack: self.videoTrack,
      audioTrack: self.audioTrack,
      videoEnabled: self.videoEnabled,
      audioEnabled: self.audioEnabled,
      isScreenShare: false,
    });
  }, []);

  const participantToState = useCallback((p: RTKParticipant): ParticipantState => ({
    id: p.id,
    name: p.name || 'Participant',
    videoTrack: p.videoTrack,
    audioTrack: p.audioTrack,
    videoEnabled: p.videoEnabled,
    audioEnabled: p.audioEnabled,
    isScreenShare: false,
  }), []);

  const updateParticipants = useCallback(() => {
    if (!isMountedRef.current || !meetingRef.current) return;
    const active = meetingRef.current.participants.active;
    const selfId = meetingRef.current.self.id;
    const map = participantsMapRef.current;
    
    // Get current remote participants from SDK
    const selfClientId = (meetingRef.current.self as any).clientSpecificId;
    const activeParticipants = (active.toArray() as any[]).filter((p: any) => {
      // Filter out self by ID
      if (p.id === selfId) return false;
      // Filter out duplicate of self by clientSpecificId
      if (p.clientSpecificId && selfClientId && p.clientSpecificId === selfClientId) return false;
      return true;
    });
    
    // Deduplicate by ID
    const dedupedMap = new Map<string, any>();
    for (const p of activeParticipants) {
      dedupedMap.set(p.id, p);
    }
    const uniqueParticipants = Array.from(dedupedMap.values());
    
    const ids = uniqueParticipants.map((p: any) => p.id);
    const hasDuplicates = ids.length !== new Set(ids).size;
    console.log('updateParticipants:', {
      selfId,
      activeCount: active.toArray().length,
      remoteCount: uniqueParticipants.length,
      hasDuplicates,
      remoteIds: uniqueParticipants.map((p: any) => ({ id: p.id, name: p.name }))
    });
    
    // Remove participants that are no longer present
    const currentIds = new Set(uniqueParticipants.map((p: any) => p.id));
    for (const [id] of map) {
      if (!currentIds.has(id)) {
        map.delete(id);
      }
    }
    
    // Add or update current participants
    for (const p of uniqueParticipants) {
      map.set(p.id, participantToState(p as any));
    }
    
    // Convert to array for React state
    setRemoteParticipants(Array.from(map.values()));
  }, [participantToState]);

  useEffect(() => {
    isMountedRef.current = true;
    let meeting: MeetingState['meeting'] | null = null;

    async function init() {
      try {
        const res = await fetch('/api/meeting/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId: initialMeetingId })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to get auth token');
        }

        const { authToken, meetingId: realMeetingId } = await res.json();
        console.log('Got authToken for meeting:', realMeetingId);

        // Update the meeting ID to the real Cloudflare meeting ID
        if (realMeetingId && realMeetingId !== initialMeetingId) {
          setMeetingId(realMeetingId);
          // Update URL so the invite link is correct
          window.history.replaceState(null, '', `/?id=${realMeetingId}`);
        }

        meeting = await RealtimeKitClient.init({
          authToken,
          defaults: { audio: true, video: true }
        });
        meetingRef.current = meeting;
        (window as any).__MEETING__ = meeting;
        console.log('RealtimeKit initialized');

        await meeting.join();
        console.log('Joined meeting');

        if (!isMountedRef.current) {
          meeting.leave();
          return;
        }

        // Update self state
        updateSelfState(meeting.self);
        
        // Update participants
        updateParticipants();

        // Use a local const for type narrowing
        const activeMeeting = meeting;
        
        // Subscribe to self events
        activeMeeting.self.on('videoUpdate', () => updateSelfState(activeMeeting.self));
        activeMeeting.self.on('audioUpdate', () => updateSelfState(activeMeeting.self));

        // Subscribe to participant events
        const activeParticipants = activeMeeting.participants.active;
        
        activeParticipants.on('participantJoined', () => {
          updateParticipants();
        });
        
        activeParticipants.on('participantLeft', () => {
          updateParticipants();
        });
        
        activeParticipants.on('participantsUpdate', () => {
          updateParticipants();
        });

        // Subscribe to individual participant media updates
        const subscribeToParticipant = (p: RTKParticipant) => {
          p.on('videoUpdate', updateParticipants);
          p.on('audioUpdate', updateParticipants);
        };

        // Subscribe to existing participants
        activeParticipants.toArray().forEach(subscribeToParticipant);
        
        // Subscribe to new participants
        activeParticipants.on('participantJoined', (payload: RTKParticipant) => {
          subscribeToParticipant(payload);
        });

        setLoading(false);
      } catch (err) {
        console.error('Meeting init error:', err);
        if (isMountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      isMountedRef.current = false;
      if (meeting) {
        meeting.leave();
      }
    };
  }, [initialMeetingId, updateSelfState, updateParticipants]);

  const toggleAudio = useCallback(() => {
    const meeting = meetingRef.current;
    if (!meeting) return;
    
    if (meeting.self.audioEnabled) {
      meeting.self.disableAudio();
    } else {
      meeting.self.enableAudio();
    }
    updateSelfState(meeting.self);
  }, [updateSelfState]);

  const toggleVideo = useCallback(() => {
    const meeting = meetingRef.current;
    if (!meeting) return;
    
    if (meeting.self.videoEnabled) {
      meeting.self.disableVideo();
    } else {
      meeting.self.enableVideo();
    }
    updateSelfState(meeting.self);
  }, [updateSelfState]);

  const leaveMeeting = useCallback(() => {
    const meeting = meetingRef.current;
    if (meeting) {
      meeting.leave();
    }
    window.location.href = '/';
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        Connecting to meeting...
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black text-white">
        <div className="text-red-400 mb-4">Error: {error}</div>
        <button onClick={() => window.location.href = '/'} className="px-4 py-2 bg-blue-600 rounded">
          Back to Home
        </button>
      </div>
    );
  }

  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/?id=${meetingId}` : '';

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <header className="bg-gray-900 text-white p-4 flex justify-between items-center">
        <h1 className="font-bold">Meeting: {meetingId}</h1>
        <button
          onClick={() => navigator.clipboard.writeText(inviteLink)}
          className="text-sm bg-gray-700 px-3 py-1 rounded hover:bg-gray-600"
        >
          Copy Link
        </button>
      </header>
      <main className="flex-1 overflow-auto">
        <ParticipantGrid
          localParticipant={localParticipant}
          remoteParticipants={remoteParticipants}
        />
      </main>
      <div className="bg-gray-900 p-4 flex justify-center gap-4">
        <button
          onClick={toggleAudio}
          className={`px-6 py-3 rounded-full ${localParticipant.audioEnabled ? 'bg-gray-700' : 'bg-red-600'} text-white hover:opacity-80`}
        >
          {localParticipant.audioEnabled ? '🎤' : '🔇'}
        </button>
        <button
          onClick={toggleVideo}
          className={`px-6 py-3 rounded-full ${localParticipant.videoEnabled ? 'bg-gray-700' : 'bg-red-600'} text-white hover:opacity-80`}
        >
          {localParticipant.videoEnabled ? '📹' : '📷'}
        </button>
        <button
          onClick={leaveMeeting}
          className="px-6 py-3 rounded-full bg-red-600 text-white hover:opacity-80"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const meetingId = searchParams.get('id');
  const [newMeetingId, setNewMeetingId] = useState('');

  const createMeeting = () => {
    const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
    window.history.replaceState(null, '', `/?id=${id}`);
  };

  const joinMeeting = () => {
    if (newMeetingId.trim()) {
      window.history.replaceState(null, '', `/?id=${newMeetingId.trim()}`);
    }
  };

  if (meetingId) {
    return <MeetingContent initialMeetingId={meetingId} />;
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-4">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Cloudflare Meet</h1>
        
        <div className="space-y-6">
          <div className="text-center">
            <p className="text-gray-600 mb-4">Start a new meeting</p>
            <button
              onClick={createMeeting}
              className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700"
            >
              New Meeting
            </button>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-gray-500">or</span>
            </div>
          </div>

          <div>
            <p className="text-gray-600 mb-4">Join an existing meeting</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newMeetingId}
                onChange={(e) => setNewMeetingId(e.target.value)}
                placeholder="Enter meeting ID"
                className="flex-1 px-4 py-3 border border-gray-300 rounded-lg"
              />
              <button
                onClick={joinMeeting}
                disabled={!newMeetingId.trim()}
                className="px-6 bg-green-600 text-white rounded-lg disabled:opacity-50 hover:bg-green-700"
              >
                Join
              </button>
            </div>
          </div>
        </div>

        <p className="text-xs text-gray-400 text-center mt-6">
          Powered by Cloudflare RealtimeKit
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <HomeContent />
    </Suspense>
  );
}
