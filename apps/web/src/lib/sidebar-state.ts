/**
 * cc27 (UX26-11, D-456): la cookie donde el menú lateral guarda si quedó abierto o colapsado.
 * Vive fuera de `components/ui/sidebar.tsx` porque ese módulo es de cliente y el layout, que la
 * lee para abrir el menú como se dejó, es de servidor.
 */
export const SIDEBAR_COOKIE_NAME = 'sidebar_state';
