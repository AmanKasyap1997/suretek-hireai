import { useId, type ReactElement } from 'react';

/** Decorative provider logos for the Integrations page. */
type Logo = {
  Svg: () => ReactElement;
  /** The logo is a whole tile (its own background); others sit on white. */
  fill?: boolean;
};

/** An SVG id unique on the page, usable in url(#…). */
function useSvgId(name: string) {
  return `${name}-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function OpenAiLogo() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      >
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <path
            key={angle}
            d="M12 2.4C8.5.8 5 3.4 5 6.8v5.5l7 4 4-2.3V9"
            transform={angle ? `rotate(${angle} 12 12)` : undefined}
          />
        ))}
      </g>
    </svg>
  );
}

export function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.19 5.48-4.7 7.18l7.73 6C44.48 38.03 46.98 31.9 46.98 24.55z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59a14.41 14.41 0 0 1 0-9.18l-7.98-6.19a24 24 0 0 0 0 21.56z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6C30.03 37.65 27.25 38.5 24 38.5c-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function GoogleCalendarLogo() {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="10" width="28" height="28" fill="#FFFFFF" />
      <path fill="#4285F4" d="M38 2H6a4 4 0 0 0-4 4v32h10V12h26z" />
      <path fill="#1967D2" d="M2 38h10v8H6a4 4 0 0 1-4-4z" />
      <path fill="#34A853" d="M12 36h24v10H12z" />
      <path fill="#FBBC04" d="M36 12h10v24H36z" />
      <path fill="#188038" d="M36 36h10L36 46z" />
      <path fill="#EA4335" d="M38 2h4a4 4 0 0 1 4 4v6H36V2z" />
      <text
        x="24"
        y="30"
        textAnchor="middle"
        fontSize="17"
        fontWeight="600"
        fontFamily="Arial, sans-serif"
        fill="#4285F4"
      >
        31
      </text>
    </svg>
  );
}

function MicrosoftCalendarLogo() {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <rect x="14" y="5" width="32" height="37" rx="3" fill="#0078D4" />
      <rect x="14" y="5" width="32" height="10" rx="3" fill="#0364B8" />
      <g fill="#85CFF5">
        <rect x="19" y="19" width="6" height="5" />
        <rect x="27" y="19" width="6" height="5" />
        <rect x="35" y="19" width="6" height="5" />
        <rect x="19" y="26" width="6" height="5" />
        <rect x="35" y="26" width="6" height="5" />
        <rect x="19" y="33" width="6" height="5" />
        <rect x="27" y="33" width="6" height="5" />
        <rect x="35" y="33" width="6" height="5" />
      </g>
      <rect x="27" y="26" width="6" height="5" fill="#FFFFFF" />
      <rect x="1" y="13" width="23" height="24" rx="2" fill="#106EBE" />
      <text
        x="12.5"
        y="31"
        fill="#FFFFFF"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontSize="20"
        fontWeight="bold"
      >
        O
      </text>
    </svg>
  );
}

function AnthropicLogo() {
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <rect width="48" height="48" rx="10" fill="#F3DED1" />
      <path
        fill="#191919"
        fillRule="evenodd"
        d="M15 10h6L33 38h-7l-3-8H12l-3 8H3z M14 24h7l-3.5-9z"
      />
      <path fill="#191919" d="M28 10h6l12 28h-7z" />
    </svg>
  );
}

function GeminiLogo() {
  // Unique per logo: the page shows a provider's logo more than once.
  const gradient = useSvgId('gemini-gradient');
  return (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="50%" stopColor="#617BEE" />
          <stop offset="100%" stopColor="#BB85FC" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        d="M24 0C24 14 34 24 48 24 34 24 24 34 24 48 24 34 14 24 0 24 14 24 24 14 24 0Z"
      />
    </svg>
  );
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}

function LinkedInLogo() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <g fill="#FFFFFF">
        <circle cx="6.6" cy="6.4" r="1.8" />
        <path d="M5.1 9.4h3v9.8h-3z" />
        <path d="M10.2 9.4h2.9v1.35c.45-.85 1.55-1.65 3.15-1.65 3.1 0 3.65 2 3.65 4.6v5.5h-3v-4.85c0-1.15-.05-2.65-1.6-2.65-1.65 0-1.9 1.25-1.9 2.55v4.95h-3.2z" />
      </g>
    </svg>
  );
}
function PlivoLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="66"
      height="24"
      viewBox="0 0 66 24"
      fill="none"
    >
      <path
        d="M28.5501 6.05746C29.9177 6.05746 31.0264 4.90276 31.0264 3.47836C31.0264 2.05396 29.9177 0.899254 28.5501 0.899254C27.1824 0.899254 26.0737 2.05396 26.0737 3.47836C26.0737 4.90276 27.1824 6.05746 28.5501 6.05746Z"
        fill="black"
      />
      <path
        d="M23.7103 22.3541V1.2623C23.7103 1.1527 23.6212 1.06022 23.5082 1.06022H19.3056C19.196 1.06022 19.1035 1.14927 19.1035 1.2623V22.3507C19.1035 22.4603 19.1926 22.5527 19.3056 22.5527H23.5082C23.6178 22.5527 23.7103 22.4637 23.7103 22.3507V22.3541ZM26.5771 22.5527H30.7797C30.8893 22.5527 30.9818 22.4637 30.9818 22.3507V7.70492C30.9818 7.59531 30.8927 7.50284 30.7797 7.50284H26.5771C26.4675 7.50284 26.375 7.59189 26.375 7.70492V22.3507C26.375 22.4603 26.4641 22.5527 26.5771 22.5527ZM43.9663 7.70834L40.9317 16.2848L37.9005 7.63984C37.8731 7.55764 37.7977 7.50626 37.7121 7.50626H33.0642C32.9204 7.50626 32.8245 7.65012 32.8793 7.7837L38.7876 22.4294C38.8184 22.5048 38.8903 22.5562 38.9725 22.5562H42.4148C42.4935 22.5562 42.5655 22.5082 42.5997 22.4363L49.0458 7.79055C49.104 7.65697 49.0081 7.50969 48.8608 7.50969H44.1855C44.0999 7.50969 44.0246 7.56449 43.9972 7.64327L43.9663 7.70834Z"
        fill="black"
      />
      <path
        d="M42.4149 22.7309H38.9727C38.822 22.7309 38.685 22.6384 38.6233 22.4945L32.715 7.84879C32.6671 7.73234 32.6807 7.59876 32.7493 7.49601C32.8178 7.39325 32.9376 7.32818 33.0609 7.32818H37.7088C37.8698 7.32818 38.0136 7.43093 38.065 7.58163L40.9284 15.7505L43.8329 7.56451C43.8774 7.43093 44.0213 7.3316 44.1822 7.3316H48.8575C48.9877 7.3316 49.1041 7.39668 49.176 7.50286C49.2445 7.60903 49.2582 7.74261 49.2069 7.85907L42.7608 22.5048C42.6957 22.6452 42.5587 22.7309 42.4149 22.7309ZM33.0644 7.68439L33.0438 7.71864L38.9521 22.3644L42.4149 22.3815L48.8849 7.72206L48.8609 7.68781L44.1822 7.69809L44.1548 7.72206L44.1274 7.78029L40.9284 16.8191L37.7328 7.70151L33.0644 7.68439ZM30.7798 22.7274H26.5772C26.3683 22.7274 26.197 22.5562 26.197 22.3507V7.70494C26.197 7.49601 26.3683 7.32475 26.5772 7.32475H30.7798C30.9887 7.32475 31.1566 7.49601 31.1566 7.70494V22.3507C31.1566 22.5596 30.9853 22.7274 30.7798 22.7274ZM26.5772 7.67754C26.5772 7.67754 26.5498 7.68781 26.5498 7.70494V22.3507C26.5498 22.3507 26.5601 22.3781 26.5772 22.3781H30.7798C30.7798 22.3781 30.8038 22.3678 30.8038 22.3507V7.70494C30.8038 7.70494 30.7935 7.67754 30.7798 7.67754H26.5772ZM23.5083 22.7274H19.3057C19.0968 22.7274 18.9255 22.5562 18.9255 22.3507V1.26232C18.9255 1.05339 19.0968 0.882133 19.3057 0.882133H23.5083C23.7173 0.882133 23.8851 1.05339 23.8851 1.26232V22.3541C23.8851 22.5596 23.7138 22.7274 23.5083 22.7274ZM19.3057 1.23492C19.3057 1.23492 19.2783 1.24519 19.2783 1.26232V22.3507C19.2783 22.3507 19.2886 22.3781 19.3057 22.3781H23.5083C23.5083 22.3781 23.5323 22.3678 23.5323 22.3507V1.26232C23.5323 1.26232 23.522 1.23492 23.5083 1.23492H19.3057Z"
        fill="black"
      />
      <path
        d="M6.4546 10.0443C5.93398 10.2464 5.40651 10.3799 4.95098 10.7225C4.25568 11.2465 3.9851 11.9658 3.72479 12.7672C3.69739 12.8049 3.62546 12.8049 3.60149 12.7672C3.40625 12.2466 3.26925 11.726 2.92674 11.2773C2.34447 10.5135 1.79303 10.421 0.964156 10.0854C0.899079 10.058 0.823727 10.0409 0.878528 9.94838C0.902504 9.90728 1.63548 9.66752 1.75193 9.61614C2.46778 9.31131 2.99182 8.78042 3.29665 8.06457C3.4131 7.78714 3.48846 7.48573 3.61176 7.21515L3.67341 7.1946L3.73849 7.2494C3.98167 8.02005 4.24883 8.70849 4.8996 9.22226C5.35514 9.58189 5.88945 9.72917 6.42377 9.92783C6.46487 9.9518 6.46145 10.0032 6.45117 10.0443H6.4546Z"
        fill="black"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.28994 0.89241L6.01277 1.63223L16.3292 6.29722C16.3292 6.29722 16.3634 6.31435 16.3771 6.32462L16.4833 6.3897C16.6032 6.48903 16.8429 6.78016 16.8292 7.14322V12.4453C16.8224 12.6713 16.7162 13.1474 16.3737 13.3666C16.36 13.3803 16.3395 13.3906 16.3223 13.3975L8.79053 16.8739V22.3575C8.79053 22.5528 8.63297 22.7103 8.43774 22.7103H4.17691C3.98168 22.7103 3.82413 22.5528 3.82413 22.3575V14.1681C3.82413 14.1476 3.82413 14.127 3.82755 14.1099C3.83783 13.9832 3.93716 13.6886 4.24199 13.5105C4.25227 13.5036 4.26597 13.4968 4.27967 13.4899L12.1369 9.86618L3.85838 6.12939C3.7522 6.08144 3.70083 5.96841 3.7248 5.86223V5.68755L3.77275 1.66648C3.70768 1.00201 4.09129 0.87871 4.29337 0.89926V0.89241H4.28994Z"
        fill="black"
      />
      <path
        d="M57.4577 6.94113C52.8167 6.94113 49.0559 10.5615 49.0559 15.0278C49.0559 19.4941 52.8167 23.1179 57.4577 23.1179C62.0987 23.1179 65.8595 19.4976 65.8595 15.0278C65.8595 10.558 62.0987 6.94113 57.4577 6.94113ZM57.4577 18.5077C55.6492 18.5077 54.1833 16.9493 54.1833 15.0278C54.1833 13.1063 55.6492 11.5479 57.4577 11.5479C59.2661 11.5479 60.7321 13.1063 60.7321 15.0278C60.7321 16.9493 59.2661 18.5077 57.4577 18.5077Z"
        fill="black"
      />
    </svg>
  );
}

/** Logos by integration provider id. */
export const providerLogos: Record<string, Logo> = {
  openai: { Svg: OpenAiLogo },
  anthropic: { Svg: AnthropicLogo, fill: true },
  google_ai: { Svg: GeminiLogo },
  google_calendar: { Svg: GoogleCalendarLogo },
  microsoft_calendar: { Svg: MicrosoftCalendarLogo },
  plivo: { Svg: PlivoLogo },
};

/**
 * The page's header art shows the companies (Google, Microsoft, LinkedIn)
 * where the cards show their products.
 */
export const heroLogos: Record<string, Logo> = {
  ...providerLogos,
  google_ai: { Svg: GoogleLogo },
  microsoft_calendar: { Svg: MicrosoftLogo },
  linkedin: { Svg: LinkedInLogo },
  linkedin_profile: { Svg: LinkedInLogo },
  linkedin_jobs: { Svg: LinkedInLogo },
};
