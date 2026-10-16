'use client';

import React from 'react';
import { AppShell } from '../components/AppShell';
import { MbgProvider } from '../lib/mbg-store';

export default function HomePage() {
  return (
    <MbgProvider>
      <AppShell />
    </MbgProvider>
  );
}
