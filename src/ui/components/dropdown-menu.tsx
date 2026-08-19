"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { m, AnimatePresence } from "framer-motion";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { durations, easings, springs } from "../lib/motion";

interface DropdownMenuContextValue {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | undefined>(undefined);

function useDropdownMenuContext() {
	const context = React.useContext(DropdownMenuContext);
	if (!context) {
		throw new Error("DropdownMenu components must be used within a DropdownMenu provider");
	}
	return context;
}

interface DropdownMenuProps {
	children: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

function DropdownMenu({ children, open: controlledOpen, onOpenChange }: DropdownMenuProps) {
	const [internalOpen, setInternalOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);

	const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
	const handleOpenChange = onOpenChange || setInternalOpen;

	React.useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (open && triggerRef.current && !triggerRef.current.contains(event.target as Node)) {
				handleOpenChange(false);
			}
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && open) {
				handleOpenChange(false);
			}
		};

		document.addEventListener("click", handleClickOutside);
		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("click", handleClickOutside);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [open, handleOpenChange]);

	return (
		<DropdownMenuContext.Provider value={{ open, onOpenChange: handleOpenChange, triggerRef }}>
			<div className="relative inline-block">{children}</div>
		</DropdownMenuContext.Provider>
	);
}

interface DropdownMenuTriggerProps {
	children: React.ReactNode;
	className?: string;
	asChild?: boolean;
}

function DropdownMenuTrigger({ children, className, asChild }: DropdownMenuTriggerProps) {
	const { open, onOpenChange, triggerRef } = useDropdownMenuContext();

	if (asChild && React.isValidElement(children)) {
		return React.cloneElement(children as React.ReactElement<{
			ref?: React.Ref<HTMLButtonElement>;
			onClick?: () => void;
			'aria-expanded'?: boolean;
			'aria-haspopup'?: boolean;
		}>, {
			ref: triggerRef,
			onClick: () => onOpenChange(!open),
			"aria-expanded": open,
			"aria-haspopup": true,
		});
	}

	return (
		<button
			ref={triggerRef}
			type="button"
			onClick={() => onOpenChange(!open)}
			aria-expanded={open}
			aria-haspopup="true"
			className={className}
		>
			{children}
		</button>
	);
}

interface DropdownMenuContentProps {
	children: React.ReactNode;
	className?: string;
	align?: "start" | "center" | "end";
	side?: "top" | "bottom";
	sideOffset?: number;
	/** Enable frosted glass effect */
	glass?: boolean;
}

export interface DropdownPositionInput {
	trigger: { top: number; left: number; right: number; bottom: number; width: number };
	menu: { width: number; height: number };
	viewport: { width: number; height: number };
	align: "start" | "center" | "end";
	side: "top" | "bottom";
	sideOffset: number;
	padding?: number;
}

/** 用 left/top 夹紧到视口，避免用 translate 对齐（会和动画 transform 互相覆盖）。 */
export function computeDropdownPosition(input: DropdownPositionInput): {
	top: number;
	left: number;
	transformOrigin: string;
} {
	const padding = input.padding ?? 12;
	const menuWidth = input.menu.width > 0 ? input.menu.width : 220;
	const menuHeight = input.menu.height;
	const { trigger, viewport, align, side, sideOffset } = input;

	let left = trigger.left;
	if (align === "end") left = trigger.right - menuWidth;
	else if (align === "center") left = trigger.left + trigger.width / 2 - menuWidth / 2;
	const maxLeft = Math.max(padding, viewport.width - menuWidth - padding);
	left = Math.min(Math.max(left, padding), maxLeft);

	let top = side === "bottom" ? trigger.bottom + sideOffset : trigger.top - sideOffset - (menuHeight || 0);
	let usedSide = side;
	if (menuHeight > 0) {
		if (side === "bottom" && top + menuHeight > viewport.height - padding) {
			const flipped = trigger.top - sideOffset - menuHeight;
			if (flipped >= padding) {
				top = flipped;
				usedSide = "top";
			} else {
				top = Math.max(padding, viewport.height - menuHeight - padding);
			}
		} else if (side === "top" && top < padding) {
			const flipped = trigger.bottom + sideOffset;
			if (flipped + menuHeight <= viewport.height - padding) {
				top = flipped;
				usedSide = "bottom";
			} else {
				top = padding;
			}
		}
	}

	const originX = align === "end" ? "right" : align === "center" ? "center" : "left";
	const originY = usedSide === "top" ? "bottom" : "top";
	return { top, left, transformOrigin: `${originY} ${originX}` };
}

function DropdownMenuContent({
	children,
	className,
	align = "start",
	side = "bottom",
	sideOffset = 4,
	glass = false,
}: DropdownMenuContentProps) {
	const { open, triggerRef } = useDropdownMenuContext();
	const contentRef = React.useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = React.useState(false);
	const [position, setPosition] = React.useState({ top: 0, left: 0, transformOrigin: "top left" });

	React.useEffect(() => {
		setMounted(true);
	}, []);

	const updatePosition = React.useCallback(() => {
		const trigger = triggerRef.current;
		if (!trigger) return;
		const triggerRect = trigger.getBoundingClientRect();
		const menu = contentRef.current;
		const next = computeDropdownPosition({
			trigger: triggerRect,
			menu: menu
				? { width: menu.offsetWidth, height: menu.offsetHeight }
				: { width: 0, height: 0 },
			viewport: { width: window.innerWidth, height: window.innerHeight },
			align,
			side,
			sideOffset,
		});
		setPosition((prev) => (
			prev.top === next.top && prev.left === next.left && prev.transformOrigin === next.transformOrigin
				? prev
				: next
		));
	}, [align, side, sideOffset, triggerRef]);

	const setContentNode = React.useCallback((node: HTMLDivElement | null) => {
		contentRef.current = node;
		if (node) updatePosition();
	}, [updatePosition]);

	React.useLayoutEffect(() => {
		if (!open) return;
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open, updatePosition, children]);

	const content = (
		<AnimatePresence>
			{open && (
				<m.div
					ref={setContentNode}
					initial={{
						opacity: 0,
						scaleY: 0.9,
						scaleX: 0.96,
						y: side === "bottom" ? -8 : 8,
					}}
					animate={{
						opacity: 1,
						scaleY: 1,
						scaleX: 1,
						y: 0,
						transition: springs.swift,
					}}
					exit={{
						opacity: 0,
						scaleY: 0.9,
						scaleX: 0.96,
						y: side === "bottom" ? -4 : 4,
						transition: { duration: durations.fast, ease: easings.apple },
					}}
					role="menu"
					aria-orientation="vertical"
					className={cn(
						"fixed min-w-[220px] max-w-[min(380px,calc(100vw-24px))] overflow-x-hidden overflow-y-auto rounded-xl border border-mac-border p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.66)]",
						"bg-mac-elevated",
						className
					)}
					style={{
						zIndex: 9999,
						top: position.top,
						left: position.left,
						transformOrigin: position.transformOrigin,
					}}
				>
					{children}
				</m.div>
			)}
		</AnimatePresence>
	);

	// Use portal to escape stacking context
	if (!mounted) return null;
	return createPortal(content, document.body);
}

interface DropdownMenuItemProps {
	children: React.ReactNode;
	className?: string;
	disabled?: boolean;
	onSelect?: () => void;
	destructive?: boolean;
}

function DropdownMenuItem({
	children,
	className,
	disabled,
	onSelect,
	destructive,
}: DropdownMenuItemProps) {
	const { onOpenChange } = useDropdownMenuContext();

	const handleClick = () => {
		if (disabled) return;
		onSelect?.();
		onOpenChange(false);
	};

	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"flex w-full items-center rounded-lg px-3.5 py-[7px] text-sm text-foreground outline-none transition-colors hover:bg-mac-blue hover:text-white focus:bg-mac-blue focus:text-white",
				disabled && "pointer-events-none opacity-50",
				destructive && "text-mac-red hover:text-white hover:bg-mac-red focus:bg-mac-red",
				className
			)}
		>
			{children}
		</button>
	);
}

interface DropdownMenuCheckboxItemProps {
	children: React.ReactNode;
	className?: string;
	checked?: boolean;
	onCheckedChange?: (checked: boolean) => void;
	disabled?: boolean;
}

function DropdownMenuCheckboxItem({
	children,
	className,
	checked,
	onCheckedChange,
	disabled,
}: DropdownMenuCheckboxItemProps) {
	return (
		<button
			type="button"
			role="menuitemcheckbox"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange?.(!checked)}
			className={cn(
				"flex w-full items-center rounded-lg px-3.5 py-[7px] text-sm text-foreground outline-none transition-colors hover:bg-mac-blue hover:text-white focus:bg-mac-blue focus:text-white",
				disabled && "pointer-events-none opacity-50",
				className
			)}
		>
			<span className="mr-2 flex h-4 w-4 items-center justify-center">
				{checked && <Check className="h-3 w-3" />}
			</span>
			{children}
		</button>
	);
}

interface DropdownMenuLabelProps {
	children: React.ReactNode;
	className?: string;
}

function DropdownMenuLabel({ children, className }: DropdownMenuLabelProps) {
	return (
		<div className={cn("px-3.5 py-1.5 text-xs font-semibold text-mac-text-muted", className)}>
			{children}
		</div>
	);
}

interface DropdownMenuSeparatorProps {
	className?: string;
}

function DropdownMenuSeparator({ className }: DropdownMenuSeparatorProps) {
	return <div className={cn("-mx-1 my-1 h-px bg-mac-separator", className)} />;
}

interface DropdownMenuShortcutProps {
	children: React.ReactNode;
	className?: string;
}

function DropdownMenuShortcut({ children, className }: DropdownMenuShortcutProps) {
	return (
		<span className={cn("ml-auto text-xs tracking-widest text-mac-text-muted", className)}>
			{children}
		</span>
	);
}

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
};
