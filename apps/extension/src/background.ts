import { registerCapture } from "./capture";
import { createMenus, registerMenuHandlers } from "./menus";
import { registerMessages } from "./messages";
import { registerSniffer } from "./sniffer";

chrome.runtime.onInstalled.addListener(() => createMenus());
registerCapture();
registerMenuHandlers();
registerSniffer();
registerMessages();
