import { clsx, type ClassValue } from 'clsx'
/** Joins conditional class names. */
export const cn = (...inputs: ClassValue[]) => clsx(inputs)
