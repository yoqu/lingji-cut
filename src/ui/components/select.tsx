"use client";

import React from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";
import { durations, easings, springs } from "../lib/motion";
import { m, AnimatePresence } from "framer-motion";
import { Check, ChevronDown, X } from "lucide-react";

// ============================================================================
// Types
// ============================================================================

export interface SelectOption {
	value: string;
	label: React.ReactNode;
	disabled?: boolean;
}

interface BaseSelectProps {
	/** Placeholder text when no selection */
	placeholder?: string;
	/** Disable the select */
	disabled?: boolean;
	/** Additional class for the container */
	className?: string;
	/** Additional class for the trigger button */
	controlClassName?: string;
	/** Max items to display as text before showing count */
	maxDisplayCount?: number;
	/** Enable frosted glass effect on dropdown */
	glass?: boolean;
}

interface SingleSelectProps extends BaseSelectProps {
	type?: "single";
	value?: string;
	defaultValue?: string;
	onChange?: (e: { target: { value: string } }) => void;
	/** Options as array (alternative to children) */
	options?: SelectOption[];
	/** Children (SelectOption elements) */
	children?: React.ReactNode;
	/**
	 * Combobox 模式：允许用户在下拉之外直接输入自定义值（未命中任何 option 时
	 * 以输入字符串作为最终 value 提交）。命中 option label/value 时优先返回 option.value。
	 */
	allowCustomValue?: boolean;
	/** Combobox 模式下的过滤方式，默认 'contains'（子串匹配，大小写不敏感） */
	filterMode?: "contains" | "startsWith" | "none";
	/** 输入框变化回调（仅 combobox 模式生效，实时每击键触发） */
	onInputChange?: (text: string) => void;
}

interface MultiSelectProps extends BaseSelectProps {
	type: "multiple";
	value: string[];
	onChange: (values: string[]) => void;
	/** Options as array */
	options: SelectOption[];
	/** Show tags below the select */
	showTags?: boolean;
}

export type SelectProps = SingleSelectProps | MultiSelectProps;

// ============================================================================
// Hooks
// ============================================================================

export interface DropdownPosition {
	/** 向下展开时使用 top；向上展开时为 undefined */
	top?: number;
	/** 向上展开时使用 bottom（viewport 底部偏移）；向下展开时为 undefined */
	bottom?: number;
	left: number;
	width: number;
	/** 视口可用高度换算的最大高度；内层 ul 需要设置 overflow-y:auto 让用户滚动 */
	maxHeight: number;
	placement: "down" | "up";
}

const DROPDOWN_GAP = 4;
const DROPDOWN_SAFE_MARGIN = 8;
const DROPDOWN_MIN_HEIGHT = 160;
const DROPDOWN_FALLBACK_HEIGHT = 320;

function useDropdownPosition(
	open: boolean,
	buttonRef: React.RefObject<HTMLElement | null>,
): DropdownPosition {
	const [position, setPosition] = React.useState<DropdownPosition>({
		top: 0,
		left: 0,
		width: 0,
		maxHeight: DROPDOWN_FALLBACK_HEIGHT,
		placement: "down",
	});

	const compute = React.useCallback(() => {
		if (!buttonRef.current) return;
		const rect = buttonRef.current.getBoundingClientRect();
		const viewportHeight = window.innerHeight;

		const spaceBelow =
			viewportHeight - rect.bottom - DROPDOWN_SAFE_MARGIN - DROPDOWN_GAP;
		const spaceAbove = rect.top - DROPDOWN_SAFE_MARGIN - DROPDOWN_GAP;

		// 优先向下；向下不足 MIN_HEIGHT 且向上更宽敞时翻转向上
		const placeDown = spaceBelow >= DROPDOWN_MIN_HEIGHT || spaceBelow >= spaceAbove;

		if (placeDown) {
			setPosition({
				top: rect.bottom + DROPDOWN_GAP,
				left: rect.left,
				width: rect.width,
				maxHeight: Math.max(Math.floor(spaceBelow), DROPDOWN_MIN_HEIGHT),
				placement: "down",
			});
		} else {
			setPosition({
				bottom: viewportHeight - rect.top + DROPDOWN_GAP,
				left: rect.left,
				width: rect.width,
				maxHeight: Math.max(Math.floor(spaceAbove), DROPDOWN_MIN_HEIGHT),
				placement: "up",
			});
		}
	}, [buttonRef]);

	React.useEffect(() => {
		if (!open) return;
		compute();
		const onResize = () => compute();
		const onScroll = () => compute();
		window.addEventListener("resize", onResize);
		// capture=true：祖先滚动容器也能触发重算，避免 Dialog / Panel 内滚动后下拉脱锚
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("resize", onResize);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [open, compute]);

	return position;
}

/**
 * 点击外部关闭。支持传入多个 ref，任一 ref 命中都不算"外部"。
 *
 * 设计动机：下拉通过 createPortal 挂到 document.body，下拉 DOM 不是
 * 触发容器（trigger ref）的后代。若只检查触发容器，点击下拉选项时
 * 会被误判为"点击外部"并提前关闭，导致 onClick→handleSelect 被卸载
 * 掉，用户需要点两三次才能切换。这里同时检查触发容器与下拉节点。
 */
function useClickOutside(
	refs: Array<React.RefObject<HTMLElement | null>>,
	open: boolean,
	onClose: () => void,
) {
	const onCloseRef = React.useRef(onClose);
	React.useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	React.useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			const target = e.target as Node | null;
			if (!target) return;
			const insideAny = refs.some(
				(ref) => ref.current && ref.current.contains(target),
			);
			if (!insideAny) onCloseRef.current();
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
		// refs 数组里的 RefObject 是稳定的（useRef 产出），不参与依赖；
		// 只跟 open 走，避免每次 render 重建 listener。
	}, [open, refs]);
}

// ============================================================================
// Select Component
// ============================================================================

function SelectBase(props: SelectProps) {
	const isMultiple = props.type === "multiple";

	if (isMultiple) {
		return <MultiSelectInternal {...(props as MultiSelectProps)} />;
	}
	return <SingleSelectInternal {...(props as SingleSelectProps)} />;
}

// ============================================================================
// Single Select Internal
// ============================================================================

function SingleSelectInternal({
	children,
	className,
	controlClassName,
	value,
	defaultValue,
	onChange,
	disabled,
	options: optionsProp,
	placeholder,
	allowCustomValue = false,
	filterMode = "contains",
	onInputChange,
	glass: _glass = false,
}: SingleSelectProps) {
	const [open, setOpen] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const triggerRef = React.useRef<HTMLDivElement>(null);
	// portal 挂在 document.body，下拉 DOM 不是 containerRef 的后代，
	// 单独用一个 ref 让 click-outside 同时识别它。
	const dropdownRef = React.useRef<HTMLDivElement>(null);
	// combobox 模式用外层包裹 div 作为定位锚；常规模式沿用 button
	const anchorRef: React.RefObject<HTMLElement | null> = allowCustomValue
		? triggerRef
		: buttonRef;
	const position = useDropdownPosition(open, anchorRef);

	// useMemo 锁定数组引用，避免每次 render 都重建 listener
	const clickOutsideRefs = React.useMemo(
		() => [containerRef, dropdownRef],
		[],
	);
	useClickOutside(clickOutsideRefs, open, () => setOpen(false));

	// Parse options from children or props
	const options = React.useMemo<SelectOption[]>(() => {
		if (optionsProp) return optionsProp;
		return React.Children.toArray(children).flatMap((child) => {
			if (!React.isValidElement(child)) return [];
			const childProps = child.props as {
				value?: string;
				children?: React.ReactNode;
				disabled?: boolean;
			};
			const val = childProps.value ?? String(childProps.children ?? "");
			return [
				{
					value: String(val),
					label: childProps.children,
					disabled: childProps.disabled,
				},
			];
		});
	}, [children, optionsProp]);

	// Determine selected value
	const selected = React.useMemo(() => {
		const v = value ?? defaultValue ?? options[0]?.value ?? "";
		const match = options.find((o) => o.value === v);
		return { value: v, label: match?.label ?? v };
	}, [value, defaultValue, options]);

	// —— Combobox 模式：输入框受控值 + 用户正在输入标志 ——
	const selectedLabelText =
		typeof selected.label === "string" ? selected.label : selected.value;
	const [inputValue, setInputValue] = React.useState(selectedLabelText);
	const [userTyped, setUserTyped] = React.useState(false);

	// 外部 value 变化时，若用户未在输入，则同步显示（避免覆盖输入中状态）
	React.useEffect(() => {
		if (!allowCustomValue) return;
		if (!userTyped) setInputValue(selectedLabelText);
	}, [allowCustomValue, selectedLabelText, userTyped]);

	// 下拉关闭后清除 typing 标志，下次外部 value 变化可以正常同步
	React.useEffect(() => {
		if (!open) setUserTyped(false);
	}, [open]);

	// Combobox 模式下按输入过滤可见选项
	const visibleOptions = React.useMemo(() => {
		if (!allowCustomValue || !userTyped || filterMode === "none") return options;
		const q = inputValue.trim().toLowerCase();
		if (!q) return options;
		return options.filter((o) => {
			const hay = (typeof o.label === "string" ? o.label : o.value).toLowerCase();
			return filterMode === "startsWith" ? hay.startsWith(q) : hay.includes(q);
		});
	}, [allowCustomValue, userTyped, filterMode, inputValue, options]);

	function handleSelect(val: string) {
		onChange?.({ target: { value: val } });
		setOpen(false);
		setUserTyped(false);
	}

	function commitInputValue() {
		if (!allowCustomValue) return;
		const typed = inputValue;
		const trimmed = typed.trim();
		// 命中 value 优先，其次 label（大小写不敏感）
		const byValue = options.find((o) => o.value === trimmed);
		const byLabel = !byValue
			? options.find(
					(o) =>
						typeof o.label === "string" &&
						o.label.toLowerCase() === trimmed.toLowerCase(),
				)
			: undefined;
		const finalValue = byValue?.value ?? byLabel?.value ?? typed;
		if (finalValue !== (value ?? defaultValue ?? "")) {
			onChange?.({ target: { value: finalValue } });
		}
		setUserTyped(false);
	}

	function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
		const next = e.target.value;
		setInputValue(next);
		setUserTyped(true);
		if (!open) setOpen(true);
		onInputChange?.(next);
	}

	function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitInputValue();
			setOpen(false);
		} else if (e.key === "Escape") {
			e.preventDefault();
			setOpen(false);
			setUserTyped(false);
			setInputValue(selectedLabelText);
		} else if (e.key === "ArrowDown" && !open) {
			e.preventDefault();
			setOpen(true);
		}
	}

	function handleInputBlur(e: React.FocusEvent<HTMLInputElement>) {
		// 如果焦点跳到下拉或 chevron 按钮（同容器内），交给 onClick/onChevron 处理
		const next = e.relatedTarget as Node | null;
		if (next && containerRef.current?.contains(next)) return;
		commitInputValue();
	}

	const placeUp = position.placement === "up";
	const enterOffset = placeUp ? 8 : -8;
	const exitOffset = placeUp ? 4 : -4;
	const listboxId = React.useId();
	const hasExactMatch =
		allowCustomValue &&
		options.some(
			(o) =>
				o.value === inputValue.trim() ||
				(typeof o.label === "string" &&
					o.label.toLowerCase() === inputValue.trim().toLowerCase()),
		);
	const showCustomRow =
		allowCustomValue &&
		userTyped &&
		inputValue.trim().length > 0 &&
		!hasExactMatch;

	const dropdown =
		typeof window !== "undefined"
			? createPortal(
					<AnimatePresence>
							{open && (
								<m.div
									ref={dropdownRef}
									initial={{ opacity: 0, scaleY: 0.92, y: enterOffset }}
									animate={{
										opacity: 1,
										scaleY: 1,
										y: 0,
										transition: springs.swift,
									}}
									exit={{
										opacity: 0,
										scaleY: 0.92,
										y: exitOffset,
										transition: { duration: durations.fast, ease: easings.apple },
									}}
									style={{
										position: "fixed",
										top: position.top !== undefined ? `${position.top}px` : undefined,
										bottom: position.bottom !== undefined ? `${position.bottom}px` : undefined,
										left: `${position.left}px`,
										minWidth: `${position.width}px`,
										maxHeight: `${position.maxHeight}px`,
										transformOrigin: placeUp ? "bottom center" : "top center",
									}}
									className={cn(
										"z-[10000] flex min-w-32 flex-col overflow-hidden rounded-xl border border-mac-border bg-mac-elevated shadow-[0_10px_30px_rgba(0,0,0,0.66)]",
									)}
								>
									<ul
										id={listboxId}
										role="listbox"
										className="flex flex-col gap-0.5 overflow-y-auto overscroll-contain py-1 px-1"
									>
									{visibleOptions.map((opt) => (
										<li
											key={opt.value}
											role="option"
											aria-selected={opt.value === selected.value}
											data-disabled={opt.disabled || undefined}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => !opt.disabled && handleSelect(opt.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													if (!opt.disabled) handleSelect(opt.value);
												}
											}}
											tabIndex={opt.disabled ? -1 : 0}
											className={cn(
												"relative flex w-full shrink-0 cursor-pointer select-none items-center rounded-lg px-2 py-1.5 text-sm outline-none transition-colors",
												opt.disabled &&
													"pointer-events-none opacity-50 cursor-not-allowed",
												opt.value === selected.value
													? "bg-mac-blue text-white"
													: "text-foreground hover:bg-mac-blue hover:text-white",
											)}
										>
											{opt.label}
										</li>
									))}
									{showCustomRow && (
										<li
											role="option"
											aria-selected={false}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												commitInputValue();
												setOpen(false);
											}}
											tabIndex={0}
											className="relative flex w-full shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-mac-blue hover:text-white"
										>
											<span className="opacity-70">使用自定义值:</span>
											<span className="truncate font-medium">{inputValue}</span>
										</li>
									)}
									{visibleOptions.length === 0 && !showCustomRow && (
										<li
											className="px-2 py-2 text-sm text-muted-foreground"
											aria-disabled
										>
											无匹配选项
										</li>
									)}
								</ul>
							</m.div>
						)}
					</AnimatePresence>,
					document.body,
				)
			: null;

	if (allowCustomValue) {
		return (
			<div
				ref={containerRef}
				className={cn("relative inline-block w-full", className)}
			>
				<div
					ref={triggerRef}
					className={cn(
						"flex h-9 w-full items-center rounded-lg border border-mac-border bg-mac-elevated px-3 py-2 text-sm text-foreground outline-none transition-colors duration-150 focus-within:border-mac-blue focus-within:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]",
						disabled && "cursor-not-allowed opacity-50",
						controlClassName,
					)}
				>
					<input
						ref={inputRef}
						type="text"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={open}
						aria-controls={listboxId}
						value={inputValue}
						placeholder={placeholder ?? "Select or type..."}
						disabled={disabled}
						onChange={handleInputChange}
						onFocus={() => setOpen(true)}
						onKeyDown={handleInputKeyDown}
						onBlur={handleInputBlur}
						className="min-w-0 flex-1 truncate bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
					/>
					<button
						type="button"
						tabIndex={-1}
						aria-label={open ? "收起选项" : "展开选项"}
						disabled={disabled}
						onMouseDown={(e) => {
							// 保持 input 焦点，避免触发 blur-commit
							e.preventDefault();
						}}
						onClick={() => {
							setOpen((v) => !v);
							inputRef.current?.focus();
						}}
						className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center text-foreground/60 hover:text-foreground disabled:cursor-not-allowed"
					>
						<m.span
							animate={{ rotate: open ? 180 : 0 }}
							transition={{ duration: durations.base, ease: easings.easeOutExpo }}
							className="inline-flex"
						>
							<ChevronDown className="h-4 w-4" />
						</m.span>
					</button>
				</div>
				{dropdown}
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className={cn("relative inline-block w-full", className)}
		>
			<button
				ref={buttonRef}
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex h-9 w-full items-center justify-between rounded-lg border border-mac-border bg-mac-elevated px-3 py-2 text-sm text-foreground outline-none transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 hover:brightness-105 focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]",
					controlClassName,
				)}
			>
				<span
					className={cn(
						"truncate",
						!selected.label && "text-muted-foreground",
					)}
				>
					{selected.label || placeholder || "Select..."}
				</span>
				<m.span
					animate={{ rotate: open ? 180 : 0 }}
					transition={{ duration: durations.base, ease: easings.easeOutExpo }}
					className="ml-2 h-4 w-4 opacity-50"
				>
					<ChevronDown className="h-4 w-4" />
				</m.span>
			</button>
			{dropdown}
		</div>
	);
}

// ============================================================================
// Multi Select Internal
// ============================================================================

function MultiSelectInternal({
	value,
	onChange,
	options,
	placeholder = "Select...",
	disabled = false,
	className,
	controlClassName,
	maxDisplayCount = 2,
	showTags = true,
	glass: _glass = false,
}: MultiSelectProps) {
	const [open, setOpen] = React.useState(false);
	const containerRef = React.useRef<HTMLDivElement>(null);
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	// portal 挂在 document.body，下拉 DOM 不是 containerRef 的后代，
	// 单独用一个 ref 让 click-outside 同时识别它。
	const dropdownRef = React.useRef<HTMLDivElement>(null);
	const position = useDropdownPosition(open, buttonRef);

	// useMemo 锁定数组引用，避免每次 render 都重建 listener
	const clickOutsideRefs = React.useMemo(
		() => [containerRef, dropdownRef],
		[],
	);
	useClickOutside(clickOutsideRefs, open, () => setOpen(false));

	function toggle(val: string) {
		const has = value.includes(val);
		onChange(has ? value.filter((v) => v !== val) : [...value, val]);
	}

	function removeTag(e: React.MouseEvent, val: string) {
		e.stopPropagation();
		onChange(value.filter((v) => v !== val));
	}

	const displayValue = React.useMemo(() => {
		if (value.length === 0) return null;
		if (value.length <= maxDisplayCount) {
			return value
				.map((v) => options.find((o) => o.value === v)?.label || v)
				.join(", ");
		}
		return `${value.length} selected`;
	}, [value, options, maxDisplayCount]);

	const placeUp = position.placement === "up";
	const enterOffset = placeUp ? 8 : -8;
	const exitOffset = placeUp ? 4 : -4;

	const dropdown =
		typeof window !== "undefined"
			? createPortal(
						<AnimatePresence>
							{open && (
								<m.div
									ref={dropdownRef}
									initial={{ opacity: 0, scaleY: 0.92, y: enterOffset }}
									animate={{
										opacity: 1,
										scaleY: 1,
										y: 0,
										transition: springs.swift,
									}}
									exit={{
										opacity: 0,
										scaleY: 0.92,
										y: exitOffset,
										transition: { duration: durations.fast, ease: easings.apple },
									}}
									style={{
										position: "fixed",
										top: position.top !== undefined ? `${position.top}px` : undefined,
										bottom: position.bottom !== undefined ? `${position.bottom}px` : undefined,
										left: `${position.left}px`,
										minWidth: `${position.width}px`,
										maxHeight: `${position.maxHeight}px`,
										transformOrigin: placeUp ? "bottom center" : "top center",
									}}
									className={cn(
										"z-[10000] flex min-w-32 flex-col overflow-hidden rounded-xl border border-mac-border bg-mac-elevated shadow-[0_10px_30px_rgba(0,0,0,0.66)]",
									)}
								>
									<ul
										role="listbox"
										className="overflow-y-auto overscroll-contain p-1"
									>
									{options.map((opt) => {
										const isSelected = value.includes(opt.value);
										return (
											<li
												key={opt.value}
												role="option"
												aria-selected={isSelected}
												data-disabled={opt.disabled || undefined}
												onClick={() => !opt.disabled && toggle(opt.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														if (!opt.disabled) toggle(opt.value);
													}
												}}
												tabIndex={opt.disabled ? -1 : 0}
												className={cn(
													"relative flex w-full shrink-0 cursor-pointer select-none items-center rounded-lg py-1.5 pl-8 pr-2 text-sm outline-none transition-colors hover:bg-mac-blue hover:text-white",
													opt.disabled &&
														"pointer-events-none opacity-50 cursor-not-allowed",
													isSelected
														? "text-foreground"
														: "text-muted-foreground",
												)}
											>
												<span className="absolute left-2 flex h-4 w-4 items-center justify-center">
													<AnimatePresence>
														{isSelected && (
															<m.span
																initial={{ scale: 0, opacity: 0 }}
																animate={{ scale: 1, opacity: 1 }}
																exit={{ scale: 0, opacity: 0 }}
																transition={{ duration: durations.fast, ease: easings.apple }}
															>
																<Check className="h-3 w-3 text-mac-blue" />
															</m.span>
														)}
													</AnimatePresence>
												</span>
												{opt.label}
											</li>
										);
									})}
								</ul>
							</m.div>
						)}
					</AnimatePresence>,
					document.body,
				)
			: null;

	return (
		<div
			ref={containerRef}
			className={cn("relative inline-block w-full", className)}
		>
			<button
				ref={buttonRef}
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex h-9 w-full items-center justify-between rounded-lg border border-mac-border bg-mac-elevated px-3 py-2 text-sm text-foreground outline-none transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 hover:brightness-105 focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]",
					controlClassName,
				)}
			>
				<span
					className={cn(
						"truncate",
						!displayValue && "text-muted-foreground",
					)}
				>
					{displayValue || placeholder}
				</span>
				<m.span
					animate={{ rotate: open ? 180 : 0 }}
					transition={{ duration: durations.base, ease: easings.easeOutExpo }}
					className="ml-2 h-4 w-4 opacity-50"
				>
					<ChevronDown className="h-4 w-4" />
				</m.span>
			</button>
			{dropdown}
			{showTags && value.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mt-2">
					<AnimatePresence>
						{value.map((v) => (
							<m.span
								key={v}
								initial={{ scale: 0.8, opacity: 0 }}
								animate={{ scale: 1, opacity: 1 }}
								exit={{ scale: 0.8, opacity: 0 }}
								transition={springs.swift}
								className="inline-flex items-center gap-1.5 rounded border border-mac-separator bg-mac-control px-2 py-1 text-xs text-mac-text-sec"
							>
								{options.find((o) => o.value === v)?.label || v}
								<button
									type="button"
									className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
									onClick={(e) => removeTag(e, v)}
								>
									<X className="h-3 w-3" />
								</button>
							</m.span>
						))}
					</AnimatePresence>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Compound Components
// ============================================================================

interface SelectOptionProps {
	value?: string;
	children: React.ReactNode;
	disabled?: boolean;
}

function SelectOptionComponent(_props: SelectOptionProps) {
	// This is a marker component - options are extracted by the parent
	return null;
}
SelectOptionComponent.displayName = "Select.Option";

// ============================================================================
// Export
// ============================================================================

type SelectComponent = typeof SelectBase & {
	Option: typeof SelectOptionComponent;
};

const Select = SelectBase as SelectComponent;
Select.Option = SelectOptionComponent;

export { Select };
