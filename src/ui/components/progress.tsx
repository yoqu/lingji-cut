"use client";

import { m } from "framer-motion";
import { cn } from "../lib/utils";

interface ProgressProps {
	value?: number;
	max?: number;
	size?: "sm" | "md" | "lg";
	variant?: "default" | "success" | "warning" | "danger" | "gradient";
	indeterminate?: boolean;
	showValue?: boolean;
	className?: string;
	/** Enable frosted glass effect on track */
	glass?: boolean;
}

function Progress({
	value = 0,
	max = 100,
	size = "md",
	variant = "default",
	indeterminate = false,
	showValue = false,
	className,
	glass: _glass = false,
}: ProgressProps) {
	const percentage = Math.min(100, Math.max(0, (value / max) * 100));

	const sizeClasses = {
		sm: "h-1",
		md: "h-2",
		lg: "h-3",
	};

	const variantClasses = {
		default: "bg-mac-blue",
		success: "bg-mac-green",
		warning: "bg-mac-orange",
		danger: "bg-mac-red",
		gradient: "bg-linear-to-r from-mac-blue via-violet-500 to-mac-red",
	};

	return (
		<div className={cn("w-full", className)}>
			<div
				role="progressbar"
				aria-valuenow={indeterminate ? undefined : value}
				aria-valuemin={0}
				aria-valuemax={max}
				className={cn(
					"w-full overflow-hidden rounded-full bg-muted",
					sizeClasses[size]
				)}
			>
				{indeterminate ? (
					<m.div
						className={cn("h-full w-1/3 rounded-full", variantClasses[variant])}
						animate={{
							x: ["-100%", "400%"],
						}}
						transition={{
							repeat: Infinity,
							duration: 1.5,
							ease: "easeInOut",
						}}
					/>
				) : (
					<m.div
						className={cn("h-full rounded-full", variantClasses[variant])}
						initial={{ width: 0 }}
						animate={{ width: `${percentage}%` }}
						transition={{ duration: 0.4, ease: "easeOut" }}
					/>
				)}
			</div>
			{showValue && !indeterminate && (
				<div className="mt-1 text-right text-xs text-muted-foreground">
					{Math.round(percentage)}%
				</div>
			)}
		</div>
	);
}

export { Progress };
