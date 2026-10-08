import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class merge helper. Required by every component pulled from a shadcn registry. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
