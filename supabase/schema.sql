-- 能源管理终端 - Database Schema
-- Supabase project: energy-management (xiilortjquzormvholvr)

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- Profiles table: user public profiles
create table if not exists profiles (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  username text unique,
  display_name text,
  avatar_url text,
  bio text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable Row Level Security
alter table profiles enable row level security;

-- RLS policies
create policy "Profiles are viewable by everyone"
  on profiles for select
  using (true);

create policy "Users can insert their own profile"
  on profiles for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on profiles for update
  using (auth.uid() = user_id);
