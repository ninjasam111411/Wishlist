// Supabase project configuration.
//
// Get these two values from your Supabase project dashboard:
// Project Settings -> Data API -> "Project URL"
// Project Settings -> API Keys -> "anon public" / publishable key
//
// This file is loaded by index.html BEFORE app.js, as a plain script
// (not a module), so these become simple global values app.js can use.
//
// It's safe for this file to be public in your repo: this key is
// designed to be used from the browser. Real access control is enforced
// by the Row Level Security policies in supabase-schema.sql, not by
// keeping this key secret.

const SUPABASE_URL = "https://fobobmhfuevqdgvvyxxm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_drSkcXkElIWhoxHj2uSJ9A_GgQAFe6q";
