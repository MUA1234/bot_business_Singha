/**
 * Icon — maps a stable string name to a Lucide icon component. Using names (not
 * imported components) keeps the department catalog (src/lib/departments.ts) plain
 * data while rendering crisp SVG icons instead of emojis. Works in both server and
 * client components (Lucide icons are pure SVG, no hooks).
 */
import {
  Home,
  Users,
  Building2,
  Tag,
  ShoppingCart,
  Wallet,
  Megaphone,
  Package,
  FileText,
  HelpCircle,
  UserRound,
  CheckCircle2,
  Table,
  Rocket,
  Target,
  ListTodo,
  Settings,
  UserCog,
  Truck,
  Factory,
  Crown,
  Download,
  Printer,
  MessageSquare,
  Gauge,
  Scale,
  Car,
  Shield,
  ClipboardList,
  Fuel,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  home: Home,
  users: Users,
  "building-2": Building2,
  tag: Tag,
  "shopping-cart": ShoppingCart,
  wallet: Wallet,
  megaphone: Megaphone,
  package: Package,
  "file-text": FileText,
  "help-circle": HelpCircle,
  "user-round": UserRound,
  "check-circle": CheckCircle2,
  table: Table,
  rocket: Rocket,
  target: Target,
  "list-todo": ListTodo,
  settings: Settings,
  "user-cog": UserCog,
  truck: Truck,
  factory: Factory,
  crown: Crown,
  download: Download,
  printer: Printer,
  "message-square": MessageSquare,
  gauge: Gauge,
  scale: Scale,
  car: Car,
  shield: Shield,
  clipboard: ClipboardList,
  fuel: Fuel,
};

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 2,
}: {
  name: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const C = MAP[name] ?? LayoutDashboard;
  return <C size={size} strokeWidth={strokeWidth} className={className} aria-hidden />;
}
