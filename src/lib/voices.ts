/**
 * Curated Microsoft Edge neural voice catalog (Edge-TTS).
 * 30+ target languages, gender-balanced voice pairs per locale.
 */

export interface DubLanguage {
  code: string; // translation + whisper language code
  name: string;
  native: string;
}

export interface DubVoice {
  id: string; // edge-tts voice id
  label: string;
  gender: "F" | "M";
  lang: string; // DubLanguage.code
}

export const LANGUAGES: DubLanguage[] = [
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "bn", name: "Bengali", native: "বাংলা" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "mr", name: "Marathi", native: "मराठी" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "ur", name: "Urdu", native: "اردو" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "pl", name: "Polish", native: "Polski" },
  { code: "sv", name: "Swedish", native: "Svenska" },
  { code: "id", name: "Indonesian", native: "Indonesia" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "ne", name: "Nepali", native: "नेपाली" },
];

export const VOICES: DubVoice[] = [
  // Hindi
  { id: "hi-IN-SwaraNeural", label: "Swara", gender: "F", lang: "hi" },
  { id: "hi-IN-MadhurNeural", label: "Madhur", gender: "M", lang: "hi" },
  // English
  { id: "en-US-AvaMultilingualNeural", label: "Ava", gender: "F", lang: "en" },
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew", gender: "M", lang: "en" },
  { id: "en-US-EmmaMultilingualNeural", label: "Emma", gender: "F", lang: "en" },
  { id: "en-US-BrianMultilingualNeural", label: "Brian", gender: "M", lang: "en" },
  { id: "en-US-AriaNeural", label: "Aria", gender: "F", lang: "en" },
  { id: "en-US-ChristopherNeural", label: "Christopher", gender: "M", lang: "en" },
  { id: "en-US-JennyNeural", label: "Jenny", gender: "F", lang: "en" },
  { id: "en-US-GuyNeural", label: "Guy", gender: "M", lang: "en" },
  { id: "en-GB-SoniaNeural", label: "Sonia (UK)", gender: "F", lang: "en" },
  { id: "en-GB-RyanNeural", label: "Ryan (UK)", gender: "M", lang: "en" },
  { id: "en-IN-NeerjaNeural", label: "Neerja (IN)", gender: "F", lang: "en" },
  { id: "en-IN-PrabhatNeural", label: "Prabhat (IN)", gender: "M", lang: "en" },
  // Spanish
  { id: "es-ES-ElviraNeural", label: "Elvira (ES)", gender: "F", lang: "es" },
  { id: "es-ES-AlvaroNeural", label: "Álvaro (ES)", gender: "M", lang: "es" },
  { id: "es-MX-DaliaNeural", label: "Dalia (MX)", gender: "F", lang: "es" },
  { id: "es-MX-JorgeNeural", label: "Jorge (MX)", gender: "M", lang: "es" },
  // French
  { id: "fr-FR-DeniseNeural", label: "Denise", gender: "F", lang: "fr" },
  { id: "fr-FR-HenriNeural", label: "Henri", gender: "M", lang: "fr" },
  // German
  { id: "de-DE-KatjaNeural", label: "Katja", gender: "F", lang: "de" },
  { id: "de-DE-ConradNeural", label: "Conrad", gender: "M", lang: "de" },
  // Italian
  { id: "it-IT-ElsaNeural", label: "Elsa", gender: "F", lang: "it" },
  { id: "it-IT-DiegoNeural", label: "Diego", gender: "M", lang: "it" },
  // Portuguese
  { id: "pt-BR-FranciscaNeural", label: "Francisca (BR)", gender: "F", lang: "pt" },
  { id: "pt-BR-AntonioNeural", label: "Antônio (BR)", gender: "M", lang: "pt" },
  { id: "pt-PT-RaquelNeural", label: "Raquel (PT)", gender: "F", lang: "pt" },
  { id: "pt-PT-DuarteNeural", label: "Duarte (PT)", gender: "M", lang: "pt" },
  // Russian
  { id: "ru-RU-SvetlanaNeural", label: "Svetlana", gender: "F", lang: "ru" },
  { id: "ru-RU-DmitryNeural", label: "Dmitry", gender: "M", lang: "ru" },
  // Japanese
  { id: "ja-JP-NanamiNeural", label: "Nanami", gender: "F", lang: "ja" },
  { id: "ja-JP-KeitaNeural", label: "Keita", gender: "M", lang: "ja" },
  // Korean
  { id: "ko-KR-SunHiNeural", label: "Sun-Hi", gender: "F", lang: "ko" },
  { id: "ko-KR-InJoonNeural", label: "InJoon", gender: "M", lang: "ko" },
  // Chinese
  { id: "zh-CN-XiaoxiaoNeural", label: "Xiaoxiao", gender: "F", lang: "zh" },
  { id: "zh-CN-YunxiNeural", label: "Yunxi", gender: "M", lang: "zh" },
  { id: "zh-TW-HsiaoChenNeural", label: "HsiaoChen (TW)", gender: "F", lang: "zh" },
  // Arabic
  { id: "ar-SA-ZariyahNeural", label: "Zariyah", gender: "F", lang: "ar" },
  { id: "ar-SA-HamedNeural", label: "Hamed", gender: "M", lang: "ar" },
  // Bengali
  { id: "bn-IN-TanishaaNeural", label: "Tanishaa", gender: "F", lang: "bn" },
  { id: "bn-IN-BashkarNeural", label: "Bashkar", gender: "M", lang: "bn" },
  // Tamil
  { id: "ta-IN-PallaviNeural", label: "Pallavi", gender: "F", lang: "ta" },
  { id: "ta-IN-ValluvarNeural", label: "Valluvar", gender: "M", lang: "ta" },
  // Telugu
  { id: "te-IN-ShrutiNeural", label: "Shruti", gender: "F", lang: "te" },
  { id: "te-IN-MohanNeural", label: "Mohan", gender: "M", lang: "te" },
  // Marathi
  { id: "mr-IN-AarohiNeural", label: "Aarohi", gender: "F", lang: "mr" },
  { id: "mr-IN-ManoharNeural", label: "Manohar", gender: "M", lang: "mr" },
  // Gujarati
  { id: "gu-IN-DhwaniNeural", label: "Dhwani", gender: "F", lang: "gu" },
  { id: "gu-IN-NiranjanNeural", label: "Niranjan", gender: "M", lang: "gu" },
  // Kannada
  { id: "kn-IN-SapnaNeural", label: "Sapna", gender: "F", lang: "kn" },
  { id: "kn-IN-GaganNeural", label: "Gagan", gender: "M", lang: "kn" },
  // Malayalam
  { id: "ml-IN-SobhanaNeural", label: "Sobhana", gender: "F", lang: "ml" },
  { id: "ml-IN-MidhunNeural", label: "Midhun", gender: "M", lang: "ml" },
  // Punjabi
  { id: "pa-IN-OjasNeural", label: "Ojas", gender: "M", lang: "pa" },
  // Urdu
  { id: "ur-PK-UzmaNeural", label: "Uzma", gender: "F", lang: "ur" },
  { id: "ur-PK-AsadNeural", label: "Asad", gender: "M", lang: "ur" },
  // Turkish
  { id: "tr-TR-EmelNeural", label: "Emel", gender: "F", lang: "tr" },
  { id: "tr-TR-AhmetNeural", label: "Ahmet", gender: "M", lang: "tr" },
  // Dutch
  { id: "nl-NL-ColetteNeural", label: "Colette", gender: "F", lang: "nl" },
  { id: "nl-NL-MaartenNeural", label: "Maarten", gender: "M", lang: "nl" },
  // Polish
  { id: "pl-PL-ZofiaNeural", label: "Zofia", gender: "F", lang: "pl" },
  { id: "pl-PL-MarekNeural", label: "Marek", gender: "M", lang: "pl" },
  // Swedish
  { id: "sv-SE-SofieNeural", label: "Sofie", gender: "F", lang: "sv" },
  { id: "sv-SE-MattiasNeural", label: "Mattias", gender: "M", lang: "sv" },
  // Indonesian
  { id: "id-ID-GadisNeural", label: "Gadis", gender: "F", lang: "id" },
  { id: "id-ID-ArdiNeural", label: "Ardi", gender: "M", lang: "id" },
  // Thai
  { id: "th-TH-PremwadeeNeural", label: "Premwadee", gender: "F", lang: "th" },
  { id: "th-TH-NiwatNeural", label: "Niwat", gender: "M", lang: "th" },
  // Vietnamese
  { id: "vi-VN-HoaiMyNeural", label: "HoaiMy", gender: "F", lang: "vi" },
  { id: "vi-VN-NamMinhNeural", label: "NamMinh", gender: "M", lang: "vi" },
  // Ukrainian
  { id: "uk-UA-PolinaNeural", label: "Polina", gender: "F", lang: "uk" },
  { id: "uk-UA-OstapNeural", label: "Ostap", gender: "M", lang: "uk" },
  // Nepali
  { id: "ne-NP-HemkalaNeural", label: "Hemkala", gender: "F", lang: "ne" },
  { id: "ne-NP-SagarNeural", label: "Sagar", gender: "M", lang: "ne" },
];

export function voicesForLanguage(langCode: string): DubVoice[] {
  const direct = VOICES.filter((v) => v.lang === langCode);
  return direct.length > 0 ? direct : VOICES.filter((v) => v.lang === "en");
}

export function defaultVoiceFor(langCode: string): string {
  return voicesForLanguage(langCode)[0]?.id ?? "en-US-AvaMultilingualNeural";
}

export function voiceById(id: string): DubVoice | undefined {
  return VOICES.find((v) => v.id === id);
}

export function langName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}
