export class PresenceResponseDTO {
  ok!: boolean;

  static success(): PresenceResponseDTO {
    const dto = new PresenceResponseDTO();
    dto.ok = true;
    return dto;
  }
}
