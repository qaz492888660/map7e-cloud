<script setup>
import { useId } from 'vue'

defineProps({
  name: { type: String, default: 'files' },
  size: { type: Number, default: 68 },
})

const uid = useId()
</script>

<template>
  <svg class="map7e-category-art" :class="'map7e-category-art--' + name" :width="size" :height="size" viewBox="0 0 88 88" fill="none" aria-hidden="true">
    <defs>
      <linearGradient :id="uid + '-glass'" x1="16" y1="11" x2="69" y2="78" gradientUnits="userSpaceOnUse">
        <stop stop-color="#C9FFFF" stop-opacity=".98" />
        <stop offset=".35" stop-color="#55DFF7" stop-opacity=".92" />
        <stop offset="1" stop-color="#1389C2" stop-opacity=".86" />
      </linearGradient>
      <linearGradient :id="uid + '-blue'" x1="22" y1="12" x2="70" y2="76" gradientUnits="userSpaceOnUse">
        <stop stop-color="#DBFFFF" />
        <stop offset=".42" stop-color="#73DFF5" />
        <stop offset="1" stop-color="#287DC4" />
      </linearGradient>
      <linearGradient :id="uid + '-violet'" x1="25" y1="18" x2="64" y2="72" gradientUnits="userSpaceOnUse">
        <stop stop-color="#E0D7FF" />
        <stop offset=".48" stop-color="#A98FFF" />
        <stop offset="1" stop-color="#5084D9" />
      </linearGradient>
      <linearGradient :id="uid + '-warm'" x1="22" y1="31" x2="66" y2="69" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFF2C7" />
        <stop offset=".52" stop-color="#FFC77D" />
        <stop offset="1" stop-color="#F47FA7" />
      </linearGradient>
      <linearGradient :id="uid + '-page'" x1="25" y1="17" x2="65" y2="75" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" />
        <stop offset="1" stop-color="#99DFFF" />
      </linearGradient>
      <filter :id="uid + '-shadow'" x="4" y="4" width="82" height="82" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#18BCEB" flood-opacity=".28" />
      </filter>
    </defs>

    <g :filter="'url(#' + uid + '-shadow)'">
      <template v-if="name === 'video'">
        <ellipse cx="44" cy="45" rx="34" ry="19" transform="rotate(-28 44 45)" stroke="#91F3FF" stroke-opacity=".42" stroke-width="1.4" />
        <rect x="21" y="20" width="48" height="46" rx="13" :fill="'url(#' + uid + '-glass)'" stroke="#DAFFFF" stroke-opacity=".8" stroke-width="1.4" transform="rotate(-9 21 20)" />
        <rect x="27" y="29" width="39" height="29" rx="7" fill="#062A4A" fill-opacity=".78" stroke="#B9F8FF" stroke-opacity=".8" />
        <path d="m42 36 13 7.5L42 51V36Z" :fill="'url(#' + uid + '-page)'" />
        <path d="M29 25h17" stroke="#FFF" stroke-opacity=".7" stroke-width="2" stroke-linecap="round" />
        <circle cx="68" cy="26" r="3" fill="#D8FFFF" />
      </template>

      <template v-else-if="name === 'photos'">
        <rect x="16" y="20" width="42" height="45" rx="9" :fill="'url(#' + uid + '-violet)'" stroke="#E5DDFF" stroke-opacity=".8" stroke-width="1.3" transform="rotate(-11 16 20)" />
        <rect x="34" y="24" width="39" height="44" rx="9" :fill="'url(#' + uid + '-glass)'" stroke="#D5FFFF" stroke-opacity=".88" stroke-width="1.3" transform="rotate(8 34 24)" />
        <circle cx="59" cy="36" r="4" fill="#EFFFFF" fill-opacity=".92" />
        <path d="m38 58 9-12 7 7 5-5 8 10H38Z" fill="#FDE9B4" />
        <path d="M23 28h16" stroke="#FFF" stroke-opacity=".6" stroke-width="2" stroke-linecap="round" />
      </template>

      <template v-else-if="name === 'documents'">
        <path d="M27 15h26l13 13v40a6 6 0 0 1-6 6H27a6 6 0 0 1-6-6V21a6 6 0 0 1 6-6Z" :fill="'url(#' + uid + '-page)'" stroke="#E1FAFF" stroke-width="1.4" />
        <path d="M53 15v13h13" fill="#79C9ED" stroke="#E1FAFF" stroke-width="1.3" />
        <path d="M31 39h24M31 47h24M31 55h17" stroke="#3A92C5" stroke-opacity=".76" stroke-width="3" stroke-linecap="round" />
        <path d="M27 19h18" stroke="#FFF" stroke-opacity=".8" stroke-width="2" stroke-linecap="round" />
        <path d="M18 27v39a7 7 0 0 0 7 7" stroke="#73E8FF" stroke-opacity=".7" stroke-width="2" />
      </template>

      <template v-else-if="name === 'audio'">
        <path d="M50 19v38.5a12 12 0 1 1-7-11V27l27-6v29.5a12 12 0 1 1-7-11V16l-13 3Z" :fill="'url(#' + uid + '-violet)'" stroke="#E4DAFF" stroke-width="1.4" stroke-linejoin="round" />
        <path d="M24 31c-5 7-5 18 0 25M18 26c-8 10-8 25 0 35M69 32c5 7 5 17 0 24" stroke="#A9F5FF" stroke-opacity=".72" stroke-width="2" stroke-linecap="round" />
        <circle cx="62" cy="18" r="3" fill="#F4E9FF" />
      </template>

      <template v-else-if="name === 'novel'">
        <path d="M13 26c13-5 23-2 31 5v39c-9-7-19-10-31-5V26Z" :fill="'url(#' + uid + '-page)'" stroke="#D8F8FF" stroke-width="1.4" />
        <path d="M75 26c-13-5-23-2-31 5v39c9-7 19-10 31-5V26Z" :fill="'url(#' + uid + '-glass)'" stroke="#C7FFFF" stroke-width="1.4" />
        <path d="M20 36c8-2 14 0 18 3M20 44c8-2 14 0 18 3M20 52c8-2 14 0 18 3" stroke="#5B9DC1" stroke-opacity=".72" stroke-width="2" stroke-linecap="round" />
        <path d="M68 36c-8-2-14 0-18 3M68 44c-8-2-14 0-18 3M68 52c-8-2-14 0-18 3" stroke="#278FB9" stroke-opacity=".66" stroke-width="2" stroke-linecap="round" />
        <path d="M44 31v39" stroke="#D9FFFF" stroke-opacity=".88" stroke-width="2" />
      </template>

      <template v-else-if="name === 'private'">
        <circle cx="43" cy="43" r="27" :fill="'url(#' + uid + '-glass)'" stroke="#D7FFFF" stroke-opacity=".92" stroke-width="1.4" />
        <ellipse cx="43" cy="43" rx="12" ry="27" stroke="#E5FFFF" stroke-opacity=".58" stroke-width="1.2" />
        <ellipse cx="43" cy="43" rx="27" ry="10" stroke="#E5FFFF" stroke-opacity=".58" stroke-width="1.2" />
        <circle cx="58" cy="25" r="5" fill="#E6FFFF" fill-opacity=".9" />
        <path d="M48 53v-5a7 7 0 0 1 14 0v5" stroke="#E9FAFF" stroke-width="3" stroke-linecap="round" />
        <rect x="45" y="51" width="20" height="15" rx="4" :fill="'url(#' + uid + '-violet)'" stroke="#F0E8FF" stroke-width="1.2" />
        <circle cx="55" cy="58" r="1.5" fill="#FFF" />
      </template>

      <template v-else-if="name === 'trash'">
        <path d="M25 30h38l-3 36a6 6 0 0 1-6 5H34a6 6 0 0 1-6-5l-3-36Z" :fill="'url(#' + uid + '-glass)'" stroke="#DBFFFF" stroke-width="1.4" />
        <path d="M20 25h48M34 20h20" stroke="#E8FFFF" stroke-width="4" stroke-linecap="round" />
        <path d="M37 39v21M50 39v21" stroke="#E6FFFF" stroke-opacity=".78" stroke-width="3" stroke-linecap="round" />
        <ellipse cx="44" cy="31" rx="19" ry="4" fill="#D9FFFF" fill-opacity=".22" />
        <circle cx="68" cy="23" r="3" fill="#E4FFFF" />
      </template>

      <template v-else>
        <path d="M14 29h24l7 7h24a5 5 0 0 1 5 5v22a7 7 0 0 1-7 7H20a7 7 0 0 1-7-7V34a5 5 0 0 1 1-5Z" :fill="'url(#' + uid + '-glass)'" stroke="#D8FFFF" stroke-width="1.4" />
        <path d="M14 43h59" stroke="#D8FFFF" stroke-opacity=".72" stroke-width="2" />
        <path d="M22 36h19" stroke="#FFF" stroke-opacity=".75" stroke-width="2" stroke-linecap="round" />
      </template>
    </g>
  </svg>
</template>
