import type { FleetSummary, ScreenSummary } from "@screengoblin/contracts";

export type Asset = {
  id: string;
  name: string;
  type: "Image" | "Video" | "Web" | "Template";
  ratio: string;
  size: string;
  updated: string;
  expires?: string;
  color: string;
};

export type Playlist = {
  id: string;
  name: string;
  itemCount: number;
  duration: string;
  assigned: number;
  updated: string;
  items: string[];
  color: string;
};

export type Schedule = {
  id: string;
  name: string;
  playlist: string;
  scope: string;
  window: string;
  priority: "Normal" | "Campaign" | "Priority";
  status: "Active" | "Upcoming" | "Draft";
};

export const screens: ScreenSummary[] = [
  {
    id: "scr-001",
    name: "Main Lobby",
    location: "High School · Lobby",
    status: "online",
    orientation: "landscape",
    resolution: "3840 × 2160",
    lastSeenAt: "Just now",
    nowPlaying: "Morning announcements",
    playerVersion: "0.8.4",
    tags: ["lobby", "student-facing"],
  },
  {
    id: "scr-002",
    name: "East Hall 01",
    location: "High School · Floor 1",
    status: "online",
    orientation: "landscape",
    resolution: "1920 × 1080",
    lastSeenAt: "18 sec ago",
    nowPlaying: "Club Fair",
    playerVersion: "0.8.4",
    tags: ["hallway"],
  },
  {
    id: "scr-003",
    name: "Cafeteria Menu",
    location: "High School · Cafeteria",
    status: "warning",
    orientation: "landscape",
    resolution: "1920 × 1080",
    lastSeenAt: "4 min ago",
    nowPlaying: "Lunch Menu · Friday",
    playerVersion: "0.8.3",
    tags: ["menu", "priority"],
  },
  {
    id: "scr-004",
    name: "Library Welcome",
    location: "High School · Library",
    status: "online",
    orientation: "portrait",
    resolution: "1080 × 1920",
    lastSeenAt: "1 min ago",
    nowPlaying: "Library rotation",
    playerVersion: "0.8.4",
    tags: ["portrait", "quiet-zone"],
  },
  {
    id: "scr-005",
    name: "Auditorium Lobby",
    location: "High School · Auditorium",
    status: "offline",
    orientation: "landscape",
    resolution: "1920 × 1080",
    lastSeenAt: "18 min ago",
    nowPlaying: "Last known good · Events",
    playerVersion: "0.8.4",
    tags: ["public", "emergency-enabled"],
  },
  {
    id: "scr-006",
    name: "District Office",
    location: "Administration · Reception",
    status: "fallback",
    orientation: "landscape",
    resolution: "1920 × 1080",
    lastSeenAt: "2 min ago",
    nowPlaying: "Fallback brand loop",
    playerVersion: "0.8.2",
    tags: ["staff-facing"],
  },
];

export const assets: Asset[] = [
  {
    id: "a1",
    name: "Club Fair — September",
    type: "Image",
    ratio: "16:9",
    size: "2.4 MB",
    updated: "12 minutes ago",
    expires: "Sep 19",
    color: "violet",
  },
  {
    id: "a2",
    name: "Morning Announcements",
    type: "Template",
    ratio: "16:9",
    size: "Dynamic",
    updated: "Today, 7:02 AM",
    color: "green",
  },
  {
    id: "a3",
    name: "Friday Lunch Menu",
    type: "Template",
    ratio: "16:9",
    size: "Dynamic",
    updated: "Yesterday",
    expires: "Today",
    color: "amber",
  },
  {
    id: "a4",
    name: "Fall Sports Highlights",
    type: "Video",
    ratio: "16:9",
    size: "84.1 MB",
    updated: "Sep 8",
    color: "blue",
  },
  {
    id: "a5",
    name: "Library Study Tips",
    type: "Image",
    ratio: "9:16",
    size: "1.8 MB",
    updated: "Sep 6",
    color: "pink",
  },
  {
    id: "a6",
    name: "District Calendar",
    type: "Web",
    ratio: "Responsive",
    size: "Live",
    updated: "Sep 1",
    color: "cyan",
  },
];

export const playlists: Playlist[] = [
  {
    id: "p1",
    name: "High School Hallways",
    itemCount: 12,
    duration: "3m 15s",
    assigned: 18,
    updated: "8 min ago",
    items: [
      "Morning Announcements",
      "Club Fair — September",
      "Fall Sports Highlights",
    ],
    color: "green",
  },
  {
    id: "p2",
    name: "Main Lobby Welcome",
    itemCount: 7,
    duration: "1m 45s",
    assigned: 2,
    updated: "Yesterday",
    items: ["Welcome", "District Calendar", "Visitor information"],
    color: "blue",
  },
  {
    id: "p3",
    name: "Cafeteria Rotation",
    itemCount: 5,
    duration: "1m 10s",
    assigned: 4,
    updated: "Today, 6:52 AM",
    items: ["Friday Lunch Menu", "Nutrition info", "Student spotlight"],
    color: "amber",
  },
  {
    id: "p4",
    name: "After-school Events",
    itemCount: 9,
    duration: "2m 30s",
    assigned: 8,
    updated: "Sep 9",
    items: ["Athletics", "Clubs", "Performances"],
    color: "violet",
  },
];

export const schedules: Schedule[] = [
  {
    id: "sch1",
    name: "School Day Baseline",
    playlist: "High School Hallways",
    scope: "High School · Hallways (18)",
    window: "Weekdays · 7:00 AM–3:00 PM",
    priority: "Normal",
    status: "Active",
  },
  {
    id: "sch2",
    name: "Club Fair Campaign",
    playlist: "Club Fair rotation",
    scope: "Student-facing screens (24)",
    window: "Sep 11–19 · All day",
    priority: "Campaign",
    status: "Active",
  },
  {
    id: "sch3",
    name: "After-school Events",
    playlist: "After-school Events",
    scope: "Public areas (8)",
    window: "Weekdays · 3:00–9:00 PM",
    priority: "Normal",
    status: "Active",
  },
  {
    id: "sch4",
    name: "Picture Day Reminder",
    playlist: "Picture Day",
    scope: "High School (30)",
    window: "Sep 22–24 · 7:00 AM–2:30 PM",
    priority: "Priority",
    status: "Upcoming",
  },
  {
    id: "sch5",
    name: "Open House",
    playlist: "Open House Welcome",
    scope: "Lobby + Hallways (20)",
    window: "Sep 28 · 5:30–8:30 PM",
    priority: "Campaign",
    status: "Draft",
  },
];

export const demoFleet: FleetSummary = {
  total: 42,
  online: 39,
  warning: 1,
  offline: 1,
  fallback: 1,
};

export const activity = [
  {
    title: "Club Fair campaign published",
    meta: "Maya Chen · 24 screens",
    time: "12 min",
  },
  {
    title: "Cafeteria Menu reported low storage",
    meta: "Automatic health check",
    time: "24 min",
  },
  {
    title: "East Hall 01 updated to v0.8.4",
    meta: "Pilot update ring",
    time: "1 hr",
  },
  {
    title: "Morning announcements approved",
    meta: "Jordan Lee · High School",
    time: "2 hr",
  },
];
