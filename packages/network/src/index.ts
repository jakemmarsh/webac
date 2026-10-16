// Network package — AC protocol packet layer and message serialization

// Enums
export { PacketHeaderFlags } from './PacketHeaderFlags.js';
export { GameMessageOpcode } from './GameMessageOpcode.js';
export { GameActionType } from './GameActionType.js';
export { GameEventType, getGameEventTypeName } from './GameEventType.js';
export { GameMessageGroup } from './GameMessageGroup.js';
export { NetAuthType } from './NetAuthType.js';
export { AuthFlags } from './AuthFlags.js';
export { type AuthStyle, type LoginProfile, type WireProtocol, EOR_LOGIN_PROFILE, isValidClientVersion } from './LoginProfile.js';
export { ContactLongJump } from './ContactLongJump.js';

// Hash / checksum
export { hash32, CHECKSUM_SENTINEL } from './Hash32.js';

// Packet header
export {
  PACKET_HEADER_SIZE,
  readPacketHeader, writePacketHeader,
  calculateHeaderChecksum, hasFlag,
} from './PacketHeader.js';
export type { PacketHeaderData } from './PacketHeader.js';

// Packet fragments
export {
  FRAGMENT_HEADER_SIZE, MAX_FRAGMENT_SIZE, MAX_FRAGMENT_DATA_SIZE,
  readFragmentHeader, writeFragmentHeader,
  readFragment, writeFragment, hashFragment,
  fragmentMessage, reassembleFragments,
} from './PacketFragment.js';
export type { FragmentHeaderData, Fragment } from './PacketFragment.js';

// Packet ordering + fragment reassembly (ASSESS: network hardening)
export { OrderedPacketBuffer, MAX_OUT_OF_ORDER_BUFFER, MAX_SEQUENCE_WINDOW } from './OrderedPacketBuffer.js';
export type { OrderedPacketVerdict, OrderedPacketResult } from './OrderedPacketBuffer.js';
export { OrderedFragmentBuffer, MAX_BUFFERED_FRAGMENT_MESSAGES } from './OrderedFragmentBuffer.js';
export type { OrderedFragmentVerdict, OrderedFragmentResult } from './OrderedFragmentBuffer.js';
export { FragmentAssembler } from './FragmentAssembler.js';

// Link Status panel packet loss (retail CLinkStatusAverages)
export { LinkStatusAverages, LINK_STATUS_HEARTBEAT_MS, LINK_STATUS_AVERAGER_SAMPLES } from './LinkStatusAverages.js';
export type { LinkStatusSnapshot } from './LinkStatusAverages.js';

// Packet builder (full packet construction / parsing)
export {
  MAX_SERVER_PACKET_SIZE, MAX_CLIENT_PACKET_SIZE,
  optionalHeadersSize, writeOptionalHeaders, readOptionalHeaders,
  buildPacket, parsePacket, verifyPacketChecksum,
} from './PacketBuilder.js';
export type { OptionalHeaders, PacketData } from './PacketBuilder.js';

// Shared MovementData decoder (0xF74C body + CreateObject PhysicsDesc blob)
export { parseMovementData } from './MovementDataParser.js';
export type { ParsedMovementData, ParsedMotionAction, ParsedMoveTo, ParsedTurnTo } from './MovementDataParser.js';

// Message serialization
export {
  BinaryWriter, BinaryReader,
  serializeGameEvent, serializeGameAction, serializeDirectMessage,
  deserializeMessage,
  buildPositionPayload, parsePositionPayload,
  buildJumpActionPayload, parseJumpActionPayload,
  buildMoveToStatePayload, parseMoveToStatePayload,
  buildAutonomousPositionPayload, parseAutonomousPositionPayload,
  buildSetDesiredComponentLevelPayload, parseSetDesiredComponentLevelPayload,
  buildAdvocateTeleportPayload, parseAdvocateTeleportPayload,
  buildRentHousePayload, parseRentHousePayload,
  buildListAvailableHousesPayload, parseListAvailableHousesPayload,
  buildQueryLordPayload, parseQueryLordPayload,
  buildListChannelsPayload, parseListChannelsPayload,
  buildUseWithTargetPayload, parseUseWithTargetPayload,
  buildModifyCharacterSquelchPayload, parseModifyCharacterSquelchPayload,
  buildSetCharacterOptionPayload, parseSetCharacterOptionPayload,
  buildFinishBarberPayload, parseFinishBarberPayload,
  buildGetAndWieldItemPayload, parseGetAndWieldItemPayload,
  buildStackableMergePayload, parseStackableMergePayload,
  buildPutItemInContainerPayload, parsePutItemInContainerPayload,
  buildAddToTradePayload, parseAddToTradePayload,
  buildTargetedMeleeAttackPayload, parseTargetedMeleeAttackPayload,
  buildTargetedMissileAttackPayload, parseTargetedMissileAttackPayload,
  buildConfirmationResponsePayload, parseConfirmationResponsePayload,
  buildModifyAccountSquelchPayload, parseModifyAccountSquelchPayload,
  buildModifyGlobalSquelchPayload, parseModifyGlobalSquelchPayload,
  buildBreakAllegianceBootPayload, parseBreakAllegianceBootPayload,
  buildSetAllegianceOfficerPayload, parseSetAllegianceOfficerPayload,
  buildSetAllegianceOfficerTitlePayload, parseSetAllegianceOfficerTitlePayload,
  buildAllegianceChatBootPayload, parseAllegianceChatBootPayload,
  buildAllegianceChatGagPayload, parseAllegianceChatGagPayload,
  buildCastTargetedSpellPayload, parseCastTargetedSpellPayload,
  buildResearchSpellPayload, parseResearchSpellPayload, SPELL_FORMULA_SLOTS,
  buildAddSpellFavoritePayload, parseAddSpellFavoritePayload,
  buildRemoveSpellFavoritePayload, parseRemoveSpellFavoritePayload,
  buildChessJoinPayload, parseChessJoinPayload,
  buildChessMovePayload, parseChessMovePayload,
  buildStackableSplitTo3DPayload, parseStackableSplitTo3DPayload,
  buildGiveObjectRequestPayload, parseGiveObjectRequestPayload,
  buildChatChannelPayload, parseChatChannelPayload,
  buildSetInscriptionPayload, parseSetInscriptionPayload,
  buildTalkDirectPayload, parseTalkDirectPayload, buildAbuseLogRequestPayload,
  buildStackableSplitToWieldPayload, parseStackableSplitToWieldPayload,
  buildTrainSkillPayload, parseTrainSkillPayload,
  buildStackableSplitToContainerPayload, parseStackableSplitToContainerPayload,
  buildBuyPayload, parseBuyPayload,
  buildSellPayload, parseSellPayload,
  buildAcceptTradePayload, parseAcceptTradePayload,
  buildCreateTinkeringToolPayload, parseCreateTinkeringToolPayload,
  buildBuyHousePayload, parseBuyHousePayload,
  buildRaiseAttributePayload, parseRaiseAttributePayload,
  buildRaiseSkillPayload, parseRaiseSkillPayload,
  buildRaiseVitalPayload, parseRaiseVitalPayload,
  buildTellPayload, parseTellPayload,
  buildFellowshipCreatePayload, parseFellowshipCreatePayload,
  buildAddShortcutPayload, parseAddShortcutPayload,
  buildBookModifyPagePayload, parseBookModifyPagePayload,
  buildBookDeletePagePayload, parseBookDeletePagePayload,
  buildBookPageDataPayload, parseBookPageDataPayload,
  buildChangeStoragePermissionPayload, parseChangeStoragePermissionPayload,
  buildBootSpecificHouseGuestPayload, parseBootSpecificHouseGuestPayload,
  buildSetOpenHouseStatusPayload, parseSetOpenHouseStatusPayload,
  buildAddFriendPayload, parseAddFriendPayload,
  buildRemoveFriendPayload, parseRemoveFriendPayload,
  buildTurbineChatPayload, parseTurbineChatPayload,
  buildSetCharacterOptionsPayload, parseSetCharacterOptionsPayload,
  buildSpeechPayload, parseSpeechPayload,
  parseCharacterList, shouldSendTurbineChat,
  buildCharacterCreate, buildCharacterEnterWorldRequest,
  buildCharacterEnterWorld, buildDDDInterrogationResponse,
  buildLoginComplete, parseCharacterCreateResponse,
  parseCharacterRestoreResponse,
  parseCreateObject, parseCreateObjectFromReader, parseApproachVendor, PhysicsTimestamp,
  parseFellowshipFullUpdate, parseFellowshipUpdateFellow,
  parseAllegianceUpdate,
  parseFriendsListUpdate,
  parseEnchantmentData, parseEnchantmentFromReader, EnchantmentTypeFlags,
  parseViewContents,
  encodeWindows1252,
  decodeWindows1252,
  setString16Wire, getString16Wire,
  parseServerName,
  parseDDDBeginDDD, parseDDDDataMessage,
} from './MessageSerializer.js';
export {
  parseGameplayOptions, serializeGameplayOptions,
  CHAT_OPT_TEXT_TYPE, CHAT_OPT_DEFAULT_OPACITY, CHAT_OPT_ACTIVE_OPACITY,
  CHAT_OPT_X, CHAT_OPT_Y, CHAT_OPT_WIDTH, CHAT_OPT_HEIGHT,
  CHAT_OPT_VISIBILITY, CHAT_OPT_PLACEMENT, CHAT_OPT_PLACEMENT_ARRAY, CHAT_OPT_TITLE,
} from './PlayerModuleOptions.js';
export type { ChatWindowOptions, GameplayOptionsData } from './PlayerModuleOptions.js';
export type {
  GameEventMessage, GameActionMessage, DirectMessage, GameMessage,
  CharacterListEntry, CharacterListData,
  CharacterCreateParams, CharacterCreateResponseData,
  CharacterRestoreResponseData,
  ACPosition, CreateObjectData,
  VendorItemData, ApproachVendorData,
  FellowData, FellowshipData, FellowshipLockData,
  AllegianceMember, AllegianceData,
  FriendEntry, FriendsListData,
  EnchantmentData,
  ViewContentsItem, ViewContentsData,
  FinishBarberFields,
  SetCharacterOptionsFields,
  MotionCommandEntry, RawMotionStateFields, MovementPositionFields,
  ServerNameData,
  String16Wire,
  DDDDatType, DDDMissingIterationEntry, DDDBeginDDDData, DDDDataMessageData,
} from './MessageSerializer.js';

// ISAAC cipher
export { ISAAC, CryptoSystem } from './ISAAC.js';

// Connection management
export {
  ConnectionData, SessionState,
} from './ConnectionData.js';
export type {
  ConnectRequestData, LoginRequestData,
} from './ConnectionData.js';

// Client connection (browser-side)
export { ClientConnection, parseAgentCall, parsePairingReply, parseRelayLinkNotice, parseRoutinesGrant, probeBridgeHealth, netErrorPayloadOffset, readServerNetError } from './ClientConnection.js';
export { BRIDGE_CLOSE_IP_CAP, BRIDGE_CLOSE_WORLD_FULL, BRIDGE_CLOSE_NEW_ACCOUNT_CAP, BRIDGE_CLOSE_NEW_ACCOUNT_UNAVAILABLE, BridgeRefusalError, bridgeRefusalFromClose, bridgeRefusalOf, type BridgeRefusal } from './BridgeRefusal.js';
export type { ConnectionEventType, ConnectionEvent, ConnectionListener, DisconnectCause, BridgeHealth, HealthSocketLike, RoutinesGrant, PairingReply, RelayLinkNotice, AgentCallFrame, ServerNetError } from './ClientConnection.js';
export { hostClientConnection, NET_SNAPSHOT_INTERVAL_MS } from './NetWorker.js';
export { createConnection } from './createConnection.js';
export { hex32, msAgo, boundNetDiagnostics, NET_DIAG_END_CAUSES, NET_DIAG_MAX_MS, NET_DIAG_MAX_COUNT } from './NetDiagnostics.js';
export type { NetDiagnostics } from './NetDiagnostics.js';
export { ThreadStallClock, silenceIsOwnStall, THREAD_STALL_MIN_MS, type ThreadStall, type LinkSample } from './ThreadStall.js';
export { Connection1999, VERSION_1999 } from './era1999/Connection1999.js';
export { CREDENTIAL_BYTES_1999 } from './era1999/Login1999.js';
export type { DatPatch1999, DatPatchEvent } from './era1999/Connection1999.js';
export { ABSENT_1999, absent1999FeatureOfAction, absent1999FeatureOfOpcode } from './era1999/Absent1999.js';
export { buildFriendsCommand1999, friendsCommand1999Plan, FriendsCommand1999 } from './era1999/codecs/Misc1999.js';
export type { Absent1999Feature, Absent1999Entry } from './era1999/Absent1999.js';
export type { NetConnection, NetCommand, NetReply, NetSnapshot, NetPort } from './NetWorker.js';

// Session-capture container (for the packet-replay test corpus)
export { encodeCaptureFrame, decodeCaptureFrames } from './CaptureCodec.js';
